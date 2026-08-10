/**
 * DELEGATE mode — analyze image(s) via the opencode **vision subagent**.
 *
 * Instead of a hand-rolled HTTP call to the vision provider (pi-vision's
 * approach), this spawns a child opencode session whose agent is the hidden
 * `vision` subagent with the vision-capable model (e.g. MiniMax-M3). The
 * images travel as data-URL file parts, so the vision model sees them
 * natively in that nested session.
 *
 * Resilience (ported from `@gitawego/vision` lib/delegate.ts):
 * 1. Content-addressed cache (checked before any spawn; hits = 0 spawns).
 * 2. Custom system prompt (prepended to the delegation prompt).
 * 3. Retry + fallback (transient errors retried with backoff; a configured
 *    fallback model is tried once on exhaustion / non-retryable failure).
 * 4. Abort-aware (ToolContext.abort stops retry + skips fallback).
 * 5. Local-only mode (cache hits OK; a miss refuses before any spawn).
 */
import type { Part, Session, UserMessage } from "@opencode-ai/sdk";
import type { DetectedImage } from "./paste";
import { appendAuditEntry, truncateImagePathForLog, type AuditEntry } from "./audit";
import { cacheKey, type VisionCache } from "./cache";
import { auditPath, VISION_AGENT, type VisionConfig } from "./config";

/** The minimal SDK client slice the delegate needs (testable via a fake). */
export interface DelegateClient {
  session: {
    create(options: { body: { parentID: string; title?: string } }): Promise<{ data: Session | undefined; error?: unknown }>;
    prompt(options: {
      path: { id: string };
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }>;
        system?: string;
        tools?: Record<string, boolean>;
      };
      signal?: AbortSignal;
    }): Promise<{ data?: { info: UserMessage | Record<string, unknown>; parts: Part[] }; error?: unknown }>;
    delete(options: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }>;
  };
}

export interface DelegateDeps {
  client: DelegateClient;
  /** Parent session id (delegation runs in a child session). */
  parentSessionID: string;
  /** Resolve the configured vision model to providerID/modelID (validates it exists). */
  resolveVisionModel(providerID: string, modelID: string): Promise<{ providerID: string; modelID: string } | undefined>;
}

export interface DelegateSuccess {
  ok: true;
  text: string;
  details: {
    model: string;
    cached: boolean;
    fallback: boolean;
    sessionID: string | undefined;
  };
}

export interface DelegateFailure {
  ok: false;
  error: { code: string; message: string };
  details?: { primaryError?: string; fallbackModel?: string };
}

export type DelegateResult = DelegateSuccess | DelegateFailure;

export const NOT_CONFIGURED_MSG = [
  "Vision tool is not configured.",
  "",
  "Use the opencode vision settings (cmd palette: \"Vision settings\") or edit",
  "~/.config/opencode/vision.json to set the vision provider and model:",
  '  { "provider": "minimax", "model": "MiniMax-M3" }',
  "",
  "The provider must be configured in opencode and the model must support",
  "image input.",
].join("\n");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTransientError(err: unknown): boolean {
  const msg = errorMessage(err);
  // fetch/network errors, 5xx, 429
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|5\d\d|429/.test(msg);
}

/** Sleep helper (injectable for tests). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audit(config: VisionConfig, entry: AuditEntry): void {
  if (!config.auditLog) return;
  appendAuditEntry(auditPath(config), entry);
}

/** Extract the assistant text from a session.prompt response. */
export function extractTextFromParts(parts: Part[] | undefined): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const texts = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && typeof (p as { text?: unknown }).text === "string");
  const joined = texts.map((p) => (p as { text: string }).text).filter((t) => t.length > 0).join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

/** One subagent spawn: create child session → prompt with the images → read
 *  the assistant text. Cleans up the child session afterwards (best-effort). */
async function spawnVisionSubagent(
  deps: DelegateDeps,
  model: { providerID: string; modelID: string },
  images: DetectedImage[],
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; sessionID: string | undefined }> {
  const created = await deps.client.session.create({ body: { parentID: deps.parentSessionID, title: "vision" } });
  const child = created?.data;
  if (!child?.id) {
    throw new Error(`Failed to create vision subagent session: ${JSON.stringify(created?.error ?? "unknown")}`);
  }

  try {
    const res = await deps.client.session.prompt({
      path: { id: child.id },
      body: {
        agent: VISION_AGENT,
        model,
        parts: [
          ...images.map((img) => ({
            type: "file" as const,
            mime: img.mimeType,
            url: img.dataURL,
            filename: img.abs.split("/").pop(),
          })),
          { type: "text" as const, text: prompt },
        ],
      },
      signal,
    });

    if (res?.error) {
      throw new Error(`Vision subagent failed: ${JSON.stringify(res.error)}`);
    }
    const text = extractTextFromParts(res?.data?.parts);
    if (!text) {
      throw new Error("Vision subagent returned no text");
    }
    return { text, sessionID: child.id };
  } finally {
    // Best-effort cleanup — never fail the delegation because cleanup failed.
    deps.client.session.delete({ path: { id: child.id } }).catch(() => {});
  }
}

/**
 * Run the full DELEGATE pipeline for a set of images with ONE prompt (a batch
 * of N>1 images is analyzed in a single subagent spawn — the vision model
 * compares them natively). Cache is checked per image; a full hit returns the
 * cached text with zero spawns.
 */
export async function delegateToVisionModel(
  deps: DelegateDeps,
  config: VisionConfig,
  images: DetectedImage[],
  prompt: string,
  signal: AbortSignal | undefined,
  cache?: VisionCache,
): Promise<DelegateResult> {
  if (!config.enabled) {
    return { ok: false, error: { code: "disabled", message: "Vision tool is disabled. Enable it in the vision settings." } };
  }
  if (!config.provider || !config.model) {
    return { ok: false, error: { code: "not_configured", message: NOT_CONFIGURED_MSG } };
  }
  if (images.length === 0) {
    return { ok: false, error: { code: "no_image", message: "No images provided to delegate." } };
  }

  const model = await deps.resolveVisionModel(config.provider, config.model);
  if (!model) {
    return {
      ok: false,
      error: {
        code: "model_not_found",
        message: `Vision tool error: model "${config.provider}/${config.model}" not found or has no image input. Check the provider is configured in opencode.`,
      },
    };
  }

  const modelId = `${model.providerID}/${model.modelID}`;
  const useCache = !!(cache && config.cacheEnabled);
  const keys = useCache ? images.map((img) => cacheKey(img.sourceHash, true, config.maxDimension, config.jpegQuality, prompt, modelId, config.systemPrompt)) : undefined;

  // ── Cache check (per image) ────────────────────────────────────────────
  const cachedTexts: Array<{ image: DetectedImage; text: string }> = [];
  const misses: DetectedImage[] = [];
  if (useCache && keys && cache) {
    for (let i = 0; i < images.length; i++) {
      const hit = cache.get(keys[i]!);
      if (hit) cachedTexts.push({ image: images[i]!, text: hit.text });
      else misses.push(images[i]!);
    }
  } else {
    misses.push(...images);
  }

  // ── LOCAL-ONLY GATE ────────────────────────────────────────────────────
  // Cache hits are allowed (the cache is local); a miss refuses the network.
  if (config.localOnly && misses.length > 0) {
    const cacheHint = config.cacheEnabled
      ? "Enable delegation (local-only off) to describe it, or re-use a previously-cached description."
      : "Enable delegation (local-only off) to describe it.";
    audit(config, {
      ts: new Date().toISOString(),
      provider: config.provider ?? "(unset)",
      model: modelId,
      image_path: truncateImagePathForLog(misses[0]!.abs),
      source_hash: misses[0]!.sourceHash,
      cached: false,
      fallback: false,
      fallback_model: undefined,
      ok: false,
      error_code: "local_only",
      latency_ms: 0,
      local_only: true,
    });
    return {
      ok: false,
      error: {
        code: "local_only",
        message: `Vision tool is in local-only mode — image bytes are not sent to any provider.\n\nThis image has no cached description. ${cacheHint}\n\nTo delegate to a vision model, disable local-only mode.`,
      },
    };
  }

  // ── All cached → merge and return (0 spawns) ─────────────────────────
  if (misses.length === 0) {
    const text = formatMerged(cachedTexts, []);
    audit(config, {
      ts: new Date().toISOString(),
      provider: config.provider ?? "(unset)",
      model: modelId,
      image_path: truncateImagePathForLog(images[0]!.abs),
      source_hash: images[0]!.sourceHash,
      cached: true,
      fallback: false,
      fallback_model: undefined,
      ok: true,
      error_code: undefined,
      latency_ms: 0,
      local_only: false,
    });
    return { ok: true, text, details: { model: modelId, cached: true, fallback: false, sessionID: undefined } };
  }

  // ── Network path: primary with retry, then fallback ───────────────────
  const t0 = performance.now();
  const primary = await callWithRetry(deps, config, model, misses, prompt, signal);
  let latency_ms = Math.round(performance.now() - t0);

  let result: DelegateResult;
  if (primary.ok) {
    result = { ok: true, text: primary.text, details: { model: modelId, cached: false, fallback: false, sessionID: primary.sessionID } };
  } else if (config.fallbackProvider && config.fallbackModel) {
    const fbModel = await deps.resolveVisionModel(config.fallbackProvider, config.fallbackModel);
    if (!fbModel) {
      result = {
        ok: false,
        error: {
          code: "model_not_found",
          message: `Vision tool error: fallback model "${config.fallbackProvider}/${config.fallbackModel}" not found or has no image input.`,
        },
        details: { primaryError: primary.error.message, fallbackModel: `${config.fallbackProvider}/${config.fallbackModel}` },
      };
    } else {
      const t1 = performance.now();
      try {
        const fb = await spawnVisionSubagent(deps, fbModel, misses, prompt, signal);
        latency_ms = Math.round(performance.now() - t1);
        const fbId = `${fbModel.providerID}/${fbModel.modelID}`;
        result = { ok: true, text: fb.text, details: { model: fbId, cached: false, fallback: true, sessionID: fb.sessionID } };
      } catch (fbErr) {
        result = {
          ok: false,
          error: { code: "vision_call_error", message: `Vision tool error (fallback ${fbModel.providerID}/${fbModel.modelID}): ${errorMessage(fbErr)}` },
          details: { primaryError: primary.error.message, fallbackModel: `${fbModel.providerID}/${fbModel.modelID}` },
        };
      }
    }
  } else {
    result = { ok: false, error: primary.error, details: primary.details };
  }

  // ── Audit + cache store on success (never store a fallback result under
  //    the primary key). ─────────────────────────────────────────────────
  if (result.ok) {
    if (!result.details.fallback && useCache && keys && cache) {
      for (let i = 0; i < misses.length; i++) {
        const key = keys[images.indexOf(misses[i]!)];
        if (key) cache.set(key, { text: result.text, model: result.details.model, storedAt: Date.now() });
      }
    }
    audit(config, {
      ts: new Date().toISOString(),
      provider: config.provider ?? "(unset)",
      model: result.details.model,
      image_path: truncateImagePathForLog(misses[0]!.abs),
      source_hash: misses[0]!.sourceHash,
      cached: false,
      fallback: result.details.fallback,
      fallback_model: result.details.fallback ? result.details.model : undefined,
      ok: true,
      error_code: undefined,
      latency_ms,
      local_only: false,
    });
  } else {
    audit(config, {
      ts: new Date().toISOString(),
      provider: config.provider ?? "(unset)",
      model: modelId,
      image_path: truncateImagePathForLog(misses[0]!.abs),
      source_hash: misses[0]!.sourceHash,
      cached: false,
      fallback: false,
      fallback_model: undefined,
      ok: false,
      error_code: result.error.code,
      latency_ms,
      local_only: false,
    });
  }
  return result;
}

async function callWithRetry(
  deps: DelegateDeps,
  config: VisionConfig,
  model: { providerID: string; modelID: string },
  images: DetectedImage[],
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<
  | { ok: true; text: string; sessionID: string | undefined }
  | { ok: false; error: { code: string; message: string }; details?: { primaryError?: string; fallbackModel?: string } }
> {
  let lastErr: unknown;
  const attempts = Math.max(0, config.retryAttempts) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) {
      return { ok: false, error: { code: "aborted", message: "Vision tool aborted." } };
    }
    try {
      const res = await spawnVisionSubagent(deps, model, images, prompt, signal);
      return { ok: true, text: res.text, sessionID: res.sessionID };
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, error: { code: "aborted", message: "Vision tool aborted." } };
      }
      lastErr = err;
      const transient = isTransientError(err);
      const shouldRetry = transient && attempt < attempts - 1;
      if (!shouldRetry) break;
      const delay = Math.min(config.retryBackoffMs * 2 ** attempt, 8000);
      await sleep(delay);
    }
  }
  const msg = errorMessage(lastErr);
  if (/401|403|unauthoriz|invalid api key|forbidden/i.test(msg)) {
    return { ok: false, error: { code: "auth_failed", message: `Vision tool error: the vision provider rejected the credentials (${msg}).` } };
  }
  return { ok: false, error: { code: "vision_call_error", message: `Vision tool error: ${msg}` } };
}

/** Merge cached + fresh descriptions into one stable text block. Fresh
 *  results come from the same spawn (already joined by the vision model). */
function formatMerged(
  cachedTexts: Array<{ image: DetectedImage; text: string }>,
  fresh: Array<{ image: DetectedImage; text: string }>,
): string {
  const parts: string[] = [];
  for (const c of cachedTexts) parts.push(`[Cached] ${c.image.abs}\n${c.text}`);
  for (const f of fresh) parts.push(`[${f.image.abs}]\n${f.text}`);
  return parts.join("\n\n");
}
