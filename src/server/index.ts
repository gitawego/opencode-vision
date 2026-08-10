/**
 * opencode-vision — server plugin entry.
 *
 * Module shape (required by the opencode loader):
 *   export default { id, server }
 *
 * The TUI-side settings menu lives in the sibling package entry `./tui`
 * (`src/tui/`). A single file must NOT export both server and tui.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import type { FilePart, Model, Part } from "@opencode-ai/sdk";
import { VisionCache } from "../cache";
import { CapabilityTracker, findModel, isMultimodal, autoDetectVisionModel } from "../capability";
import {
  loadConfig,
  MAX_BATCH_IMAGES,
  saveConfig,
  TOOL_NAME,
  VISION_AGENT,
  visionConfigPath,
  type VisionConfig,
} from "../config";
import { delegateToVisionModel, type DelegateClient } from "../delegate";
import { buildDescriptionsBlock, buildHintLine } from "../marker";
import { detectImages, findImagePathTokens, rewriteWithMarkers } from "../paste";

/** Per-session primary-model capability (fed by chat.message, read by the tool). */
const tracker = new CapabilityTracker();

function cachePersistPath(config: VisionConfig): string | undefined {
  if (!config.cachePersist) return undefined;
  return `${visionConfigPath().replace(/\.json$/, "")}-cache.json`;
}

/** Rebuild the delegation cache only when its shape (persist path) changes. */
function syncCache(prev: VisionCache, config: VisionConfig): VisionCache {
  const path = cachePersistPath(config);
  if (path === (prev as unknown as { persistPath?: string }).persistPath) return prev;
  return new VisionCache(path, config.cacheMaxEntries);
}

let cache = new VisionCache(undefined, 256);
let currentConfig: VisionConfig = loadConfig();

/** One-shot memo for auto-detect (set on success or a definitive "nothing to
 *  detect"; transient failures reset it so a later message retries). */
let autoDetectAttempted = false;

const VisionPlugin: Plugin = async ({ client, directory }) => {
  currentConfig = loadConfig();
  cache = syncCache(cache, currentConfig);

  // Thin SDK adapter (keeps the delegate module SDK-shape-agnostic).
  const delegateClient: DelegateClient = {
    session: {
      create: (opts) => client.session.create(opts as never) as never,
      prompt: (opts) => client.session.prompt(opts as never) as never,
      delete: (opts) => client.session.delete(opts as never) as never,
    },
  };

  async function listProviders() {
    const res = await client.config.providers(directory ? { query: { directory } } : {});
    return res.data?.providers ?? [];
  }

  /** One-shot auto-detect of the vision model, run at first real use.
   *
   *  MUST NOT run from the config hook (client RPCs there deadlock during core
   *  init — see the comment above). By the time chat.message / describe_image
   *  run, the client is ready. Memoizes on success or a definitive "nothing to
   *  detect"; a transient provider-listing failure resets so the next use
   *  retries. */
  async function maybeAutoDetect(): Promise<void> {
    if (autoDetectAttempted) return;
    const cfgBase = loadConfig();
    if (!cfgBase.autoDetectVisionModel || (cfgBase.provider && cfgBase.model)) {
      autoDetectAttempted = true;
      return;
    }
    try {
      const providers = await listProviders();
      const detected = autoDetectVisionModel(providers, undefined);
      if (!detected) {
        autoDetectAttempted = true;
        return;
      }
      try {
        saveConfig({ ...cfgBase, provider: detected.providerID, model: detected.id });
      } catch {
        // best-effort persist — detection still memoized so we don't re-spam
      }
      autoDetectAttempted = true;
      currentConfig = loadConfig();
      cache = syncCache(cache, currentConfig);
      try {
        await client.tui.showToast({
          body: {
            variant: "info",
            title: "Vision",
            message: `Auto-configured vision model ${detected.providerID}/${detected.id}. Configure in the Vision settings.`,
          },
        });
      } catch {
        // toast is best-effort
      }
    } catch {
      // provider listing unavailable → describe_image will surface a
      // not_configured error with instructions; retry on the next use.
    }
  }

  /** Resolve a configured vision model to providerID/modelID, verifying it
   *  exists and has image input. */
  async function resolveVisionModel(
    providerID: string,
    modelID: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    const providers = await listProviders();
    const model = findModel(providers, providerID, modelID);
    if (!model || !model.capabilities?.input?.image) return undefined;
    return { providerID, modelID };
  }

  /** Resolve + track the primary model capability for a session. */
  async function trackModel(sessionID: string, model: { providerID: string; modelID: string }): Promise<Model | undefined> {
    const providers = await listProviders();
    const resolved = findModel(providers, model.providerID, model.modelID);
    tracker.set(sessionID, {
      providerID: model.providerID,
      modelID: model.modelID,
      multimodal: isMultimodal(resolved),
    });
    return resolved;
  }

  return {
    dispose: async () => {
      tracker.clear();
    },

    config: async (cfg) => {
      // ── Register the hidden vision subagent ─────────────────────────────
      // NOTE: this hook MUST NOT call the core client. Issuing a client RPC
      // here (e.g. client.config.providers) during startup deadlocks opencode:
      // the config hook runs while the core is still initializing, the response
      // is never delivered, and the await never resolves — the app hangs before
      // the TUI renders, with no error logged. Vision-model auto-detection is
      // therefore deferred to first real use (maybeAutoDetect → chat.message /
      // describe_image), when the client is guaranteed ready.
      cfg.agent ??= {};
      cfg.agent[VISION_AGENT] = {
        description:
          "Reads and describes images using a vision-capable model. Invoked automatically by the describe_image tool; also available for on-demand image analysis.",
        mode: "subagent",
        prompt:
          "You are a vision analysis agent. Analyze the image(s) attached to your message and answer the user's question. Return ONLY your analysis text — no preamble, no tool calls, no markdown fences. If no image is attached, say so.",
        permission: {
          read: "allow",
          bash: "deny",
          edit: "deny",
          webfetch: "deny",
          task: "deny",
        },
        maxSteps: 2,
      } as NonNullable<NonNullable<typeof cfg>["agent"]>[string];
    },

    "chat.message": async (input, output) => {
      // ── Track primary capability + refresh config/cache ─────────────────
      if (input.model) {
        await trackModel(input.sessionID, input.model);
      }
      await maybeAutoDetect();
      currentConfig = loadConfig();
      cache = syncCache(cache, currentConfig);

      // ── Scan text parts for image path tokens ───────────────────────────
      const textParts = output.parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text");
      if (textParts.length === 0) return;

      const tokens = findImagePathTokens(textParts.map((p) => p.text).join("\n"));
      if (tokens.length === 0) return;

      const cap = tracker.get(input.sessionID);
      const multimodal = cap?.multimodal ?? false;

      const { loaded } = detectImages(tokens, directory);
      if (loaded.length === 0) return;

      // Rewrite the first text part: markers replace the resolved tokens.
      const rewritten = rewriteWithMarkers(textParts[0]!.text, loaded, currentConfig.markerStyle);
      textParts[0]!.text = rewritten;

      // ── MULTIMODAL primary: attach natively + markers (zero delegation) ──
      if (multimodal) {
        const existing = new Set(
          output.parts
            .filter((p): p is FilePart => p.type === "file")
            .map((p) => p.url),
        );
        for (const img of loaded) {
          if (existing.has(img.dataURL)) continue;
          output.parts.push({
            id: randomUUID(),
            sessionID: input.sessionID,
            messageID: input.messageID ?? "",
            type: "file",
            mime: img.mimeType,
            url: img.dataURL,
          } as FilePart);
        }
        return;
      }

      // ── TEXT-ONLY primary: markers + hint / auto / off ───────────────────
      const hintImages = loaded.map((l) => ({ token: l.token, index: l.index }));
      const mode = currentConfig.textOnlyPasteMode;
      if (mode === "off") return;

      if (mode === "hint") {
        textParts[0]!.text = `${textParts[0]!.text}\n${buildHintLine(hintImages)}`;
        return;
      }

      // mode === "auto": auto-delegate each image (concurrency-bounded, one
      // batch AbortController with a timeout). Falls back to hint on failure.
      if (!currentConfig.provider || !currentConfig.model) {
        textParts[0]!.text = `${textParts[0]!.text}\n${buildHintLine(hintImages)}`;
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), currentConfig.autoDelegateTimeoutMs);
      const visionModel = `${currentConfig.provider}/${currentConfig.model}`;
      const descriptions: Array<{ token: string; index: number; text: string; cached: boolean }> = [];
      let ok = 0;

      try {
        const pool = Math.max(1, currentConfig.batchConcurrency);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(pool, loaded.length) }, async () => {
          while (cursor < loaded.length) {
            const i = cursor++;
            const img = loaded[i]!;
            try {
              const r = await delegateToVisionModel(
                { client: delegateClient, parentSessionID: input.sessionID, resolveVisionModel },
                currentConfig,
                [img],
                currentConfig.autoDelegatePrompt,
                controller.signal,
                cache,
              );
              if (r.ok) {
                descriptions.push({ token: img.token, index: img.index, text: r.text, cached: r.details.cached });
                ok++;
              }
            } catch {
              // per-image failure → no description
            }
          }
        });
        await Promise.all(workers);
      } finally {
        clearTimeout(timer);
      }

      if (ok === 0) {
        textParts[0]!.text = `${textParts[0]!.text}\n${buildHintLine(hintImages)}`;
        return;
      }
      textParts[0]!.text = `${textParts[0]!.text}${buildDescriptionsBlock(descriptions, visionModel)}`;
    },

    tool: {
      [TOOL_NAME]: tool({
        description:
          "Analyze one or more image files and return text descriptions or answer questions about them. ONLY call this when your model cannot process images natively — if you can already see the image, respond directly instead. Delegates to a configured vision model via a subagent. Accepts file paths, data URLs, or raw base64; pass image_paths for multiple images (batch comparison).",
        args: {
          image_path: tool.schema.string().optional().describe("Path to a single image file, a data: URL, or raw base64. Use for one image."),
          image_paths: tool.schema.array(tool.schema.string()).optional().describe("Multiple image paths/data URLs to analyze together (comparison/cross-reference). Up to 50."),
          prompt: tool.schema.string().describe("What to analyze, extract, or answer about the image(s). For multiple images, describe what to compare."),
        },
        async execute(args, context) {
          // ── Capability guard (defense-in-depth) ─────────────────────────
          const cap = tracker.get(context.sessionID);
          if (cap?.multimodal) {
            const id = `${cap.providerID}/${cap.modelID}`;
            return {
              title: "Native image support",
              output: `The active primary model (${id}) can process images natively. Use the read tool or respond directly — no delegation needed.`,
              metadata: { mode: "passthrough_redirect", model: id },
            };
          }

          // ── Normalize paths ─────────────────────────────────────────────
          const paths = normalizeImagePaths(args);
          if (paths.length === 0) {
            return {
              title: "describe_image error",
              output: "describe_image requires image_path or image_paths (got neither).",
              metadata: { error: "no_image_path" },
            };
          }
          if (paths.length > MAX_BATCH_IMAGES) {
            return {
              title: "describe_image error",
              output: `describe_image received ${paths.length} images; the batch cap is ${MAX_BATCH_IMAGES}. Split across multiple calls.`,
              metadata: { error: "batch_too_large" },
            };
          }

          // ── Load + validate the images ─────────────────────────────────
          const { loaded, unresolved } = detectImages(paths, context.directory);
          if (loaded.length === 0) {
            const details = unresolved.map((t) => `[error: not_found — image not found at "${t}"]`).join("\n");
            return {
              title: "describe_image error",
              output: `Vision tool error: no readable image(s).\n${details || "check the paths and try again."}`,
              metadata: { error: "no_readable_image", unresolved },
            };
          }

          await maybeAutoDetect();
          currentConfig = loadConfig();
          cache = syncCache(cache, currentConfig);

          const result = await delegateToVisionModel(
            { client: delegateClient, parentSessionID: context.sessionID, resolveVisionModel },
            currentConfig,
            loaded,
            args.prompt,
            context.abort,
            cache,
          );

          if (result.ok) {
            return {
              title: "Image analysis",
              output: buildToolOutput(paths, loaded, result.text, result.details.cached),
              metadata: {
                mode: "delegate",
                model: result.details.model,
                cached: result.details.cached,
                fallback: result.details.fallback,
                ...(unresolved.length > 0 ? { unresolved } : {}),
              },
            };
          }
          return {
            title: "describe_image error",
            output: result.error.message,
            metadata: { mode: "delegate", error: result.error.code },
          };
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { sessionID?: string })?.sessionID;
        if (sessionID) tracker.delete(sessionID);
      }
    },
  };
};

export default { id: "opencode-vision", server: VisionPlugin };

/** Normalize image_path / image_paths (tolerating JSON-stringified arrays),
 *  dedup, cap, and resolve order (image_paths first, then image_path). */
function normalizeImagePaths(args: { image_path?: string | string[]; image_paths?: string | string[] }): string[] {
  const coerce = (v: string | string[] | undefined): string[] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    if (typeof v !== "string") return [];
    const s = v.trim();
    if (s === "") return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
      } catch {
        // not valid JSON → treat as a single path string
      }
    }
    return [s];
  };
  const merged = [...coerce(args.image_paths), ...coerce(args.image_path)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of merged) {
    const t = p.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Build the tool result text for a (possibly batched) delegation. Since the
 *  vision subagent analyzes all images in one turn, a batch yields one combined
 *  description. */
function buildToolOutput(
  paths: string[],
  loaded: { abs: string; index: number }[],
  text: string,
  cached: boolean,
): string {
  if (paths.length === 1) {
    return cached ? `(cached)\n\n${text}` : text;
  }
  const lines: string[] = [`[Batch: ${loaded.length} image(s)]`, ""];
  for (const img of loaded) {
    lines.push(`[Image ${img.index + 1}] ${img.abs}`);
  }
  lines.push("", text);
  return lines.join("\n");
}
