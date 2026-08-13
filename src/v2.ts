/**
 * opencode-vision — opencode v2 adapter (promise-style plugin).
 *
 * Loaded through the dual-version default export in `src/index.ts`:
 *
 *   export default { id, server, setup }
 *
 * v1's loader consumes `server`; v2's supervisor decodes the default export
 * against `PluginModule` (`{ id, setup }` union variant — excess keys are
 * ignored) and runs `setup(context)` with the v2 plugin SDK
 * (`@opencode-ai/plugin` — promise domains). The v2 SDK package also ships
 * the complete v1 surface under `@opencode-ai/plugin/v1`, so ONE locally
 * installed SDK version serves both hosts.
 *
 * Behavior mirrors the v1 server adapter exactly:
 *  - registers the hidden `vision` subagent (agent domain transform)
 *  - registers the `describe_image` tool (tool domain draft.add)
 *  - rewrites session context messages (`session.hook("context")`):
 *    image-path detection → markers; native media attachment for multimodal
 *    primaries; hint / auto-delegate for text-only primaries
 *  - delegation runs in a child session via the v2 session API
 *    (create → prompt(text+files) → generate → remove)
 *  - vision-model auto-detect via the v2 catalog (`provider.list`)
 */
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { MediaPart, TextPart } from "@opencode-ai/ai";
import type { Context } from "@opencode-ai/plugin/promise/plugin";
import type { Model, Provider } from "@opencode-ai/sdk";
import { VisionCache } from "./cache";
import {
  CapabilityTracker,
  autoDetectVisionModel,
  findModel,
  isMultimodal,
  listVisionModels as collectVisionModels,
} from "./capability";
import { loadConfig, MAX_BATCH_IMAGES, saveConfig, TOOL_NAME, VISION_AGENT, visionConfigPath, type VisionConfig } from "./config";
import { delegateToVisionModel, type DelegateClient, type DelegateDeps } from "./delegate";
import { buildDescriptionsBlock, buildHintLine } from "./marker";
import { detectImages, findImagePathTokens, rewriteWithMarkers } from "./paste";
import { buildToolOutput, normalizeImagePaths } from "./tool-util";

/** Project directory for image path resolution. v2's plugin context carries no
 *  project directory (v1 passed it to the plugin input), so resolve relative
 *  paths against the opencode process CWD. */
const projectDirectory = process.cwd();

/** v2 models declare input modalities as an array (["image","text",…]); the
 *  shared capability helpers use the v1 object shape ({input:{image:bool}}).
 *  Convert when adapting catalog models. */
function toV1Model(model: unknown): Model {
  const caps = (model as { capabilities?: { input?: unknown } }).capabilities;
  const input = caps?.input;
  const image = Array.isArray(input) ? input.includes("image") : Boolean((input as { image?: boolean } | undefined)?.image);
  return { ...(model as object), capabilities: { ...caps, input: { image } } } as Model;
}

/** Same persist path as the v1 adapter: `<config dir>/vision-cache.json`. */
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

export async function setup(context: Context) {
  const tracker = new CapabilityTracker();
  let currentConfig: VisionConfig = loadConfig();
  let cache = syncCache(new VisionCache(undefined, 256), currentConfig);
  let autoDetectAttempted = false;

  // ── Catalog-backed provider/model listing (v2 replaces v1's
  //    client.config.providers) ────────────────────────────────────────────
  async function listProviders(): Promise<Provider[]> {
    const res = await context.catalog.provider.list();
    return (res?.data ?? []).map((p) => ({
      id: p.id,
      models: Object.fromEntries(
        Object.entries((p as { models?: Record<string, unknown> }).models ?? {}).map(([k, v]) => [k, toV1Model(v)]),
      ),
    })) as Provider[];
  }

  /** One-shot auto-detect of the vision model, run at first real use (the v2
   *  context hook may run during session setup; the catalog is safe to call
   *  there, unlike v1's config hook which deadlocked). */
  async function maybeAutoDetect(primaryProviderID?: string): Promise<void> {
    if (autoDetectAttempted) return;
    const cfgBase = loadConfig();
    if (!cfgBase.autoDetectVisionModel || (cfgBase.provider && cfgBase.model)) {
      autoDetectAttempted = true;
      return;
    }
    try {
      const providers = await listProviders();
      const detected = autoDetectVisionModel(providers, primaryProviderID);
      if (!detected) {
        autoDetectAttempted = true;
        return;
      }
      try {
        saveConfig({ ...cfgBase, provider: detected.providerID, model: detected.id, autoDetected: true });
      } catch {
        // best-effort persist — detection still memoized so we don't re-spam
      }
      autoDetectAttempted = true;
      currentConfig = loadConfig();
      cache = syncCache(cache, currentConfig);
      console.log(`[opencode-vision] auto-configured vision model ${detected.providerID}/${detected.id}`);
    } catch {
      // provider listing unavailable → describe_image will surface a
      // not_configured error with instructions; retry on the next use.
    }
  }

  async function resolveVisionModel(
    providerID: string,
    modelID: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    const providers = await listProviders();
    const model = findModel(providers, providerID, modelID);
    if (!model || !model.capabilities?.input?.image) return undefined;
    return { providerID, modelID };
  }

  async function trackModel(sessionID: string, model: { providerID: string; modelID: string }): Promise<void> {
    try {
      const providers = await listProviders();
      const resolved = findModel(providers, model.providerID, model.modelID);
      tracker.set(sessionID, {
        providerID: model.providerID,
        modelID: model.modelID,
        multimodal: isMultimodal(resolved),
      });
    } catch {
      // catalog unavailable → leave the tracker unknown (treated as text-only)
    }
  }

  const makeDelegateDeps = (parentSessionID: string): DelegateDeps => ({
    client: delegateClient,
    parentSessionID,
    resolveVisionModel,
    listVisionModels: async (preferredProviderID) => {
      const providers = await listProviders();
      return collectVisionModels(providers, preferredProviderID);
    },
  });

  // ── Delegate client: v1-shaped adapter over the v2 session API ──────────
  // The delegate module calls create() → prompt() → delete(). v2's session
  // API differs: the vision agent + model are set at CREATE time, images
  // travel as prompt FILES, and the assistant reply comes from `generate`
  // (v2's prompt echoes the user message, not the response). The adapter
  // defers the real create to prompt() (when agent/model are known) and maps
  // the fake create id → real session id for cleanup.
  const pendingCreates = new Map<string, { parentID: string; title?: string }>();
  const realSessionIds = new Map<string, string>();

  const delegateClient: DelegateClient = {
    session: {
      create: async ({ body }) => {
        const fake = randomUUID();
        pendingCreates.set(fake, body);
        return { data: { id: fake } as never };
      },
      prompt: async ({ path, body, signal }) => {
        const pending = pendingCreates.get(path.id);
        pendingCreates.delete(path.id);
        const textParts = body.parts.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text");
        const fileParts = body.parts.filter((p): p is Extract<typeof p, { type: "file" }> => p.type === "file");
        const text = [body.system, ...textParts.map((p) => p.text)].filter(Boolean).join("\n\n");
        const files = fileParts.map((f) => ({ uri: f.url, name: f.filename }));
        try {
          const model = body.model ? { id: body.model.modelID, providerID: body.model.providerID } : undefined;
          const location = { directory: projectDirectory };
          const createInput = {
            id: {
              title: pending?.title ?? "vision",
              agent: body.agent,
              model,
              location,
            },
          };
          let created: { id: string };
          try {
            created = await context.session.create(createInput as never);
          } catch {
            // "vision" agent not registered in this host → fall back to the
            // default agent (the model override still selects the vision model)
            created = await context.session.create({
              id: { title: pending?.title ?? "vision", model, location },
            } as never);
          }
          const sessionID = created.id;
          realSessionIds.set(path.id, sessionID);
          await context.session.prompt(
            { sessionID, text: { text, files, delivery: "steer" } } as never,
            { signal } as never,
          );
          const generated = await context.session.generate(
            { sessionID, prompt: { prompt: "" } } as never,
            { signal } as never,
          );
          const reply = (generated as { data?: { text?: string } }).data?.text ?? "";
          return { data: { info: {} as never, parts: [{ type: "text", text: reply }] as never } };
        } catch (error) {
          return { error };
        }
      },
      delete: async ({ path }) => {
        const realId = realSessionIds.get(path.id);
        realSessionIds.delete(path.id);
        if (realId) {
          // `remove` exists on the client but is excluded from the typed
          // SessionDomain Pick — call it via the client surface.
          await (context.session as unknown as { remove: (input: { sessionID: string }) => Promise<unknown> }).remove({
            sessionID: realId,
          }).catch(() => {});
        }
        return {};
      },
    },
  };

  // ── 1. Register the hidden vision subagent (best-effort; the delegation
  //    create falls back to the default agent if it is absent) ─────────────
  let agentReg: { dispose: () => Promise<void> } | undefined;
  try {
    agentReg = await context.agent.transform((draft) => {
      const agent = draft.get(VISION_AGENT);
      if (!agent) return;
      agent.description =
        "Reads and describes images using a vision-capable model. Invoked automatically by the describe_image tool; also available for on-demand image analysis.";
      agent.mode = "subagent";
      agent.system =
        "You are a vision analysis agent. Analyze the image(s) attached to your message and answer the user's question. Return ONLY your analysis text — no preamble, no tool calls, no markdown fences. If no image is attached, say so.";
      const permissions = (agent.permissions ??= {} as never);
      Object.assign(permissions as object, {
        read: "allow",
        bash: "deny",
        edit: "deny",
        webfetch: "deny",
        task: "deny",
      });
      agent.steps = 2;
    });
  } catch {
    agentReg = undefined;
  }

  // ── 2. Register the describe_image tool ─────────────────────────────────
  const toolReg = await context.tool.transform((draft) => {
    draft.add({
      name: TOOL_NAME,
      description:
        "Analyze one or more image files and return text descriptions or answer questions about them. ONLY call this when your model cannot process images natively — if you can already see the image, respond directly instead. Delegates to a configured vision model via a subagent. Accepts file paths, data URLs, or raw base64; pass image_paths for multiple images (batch comparison).",
      input: Schema.Struct({
        image_path: Schema.optional(Schema.String),
        image_paths: Schema.optional(Schema.Array(Schema.String)),
        prompt: Schema.String,
      }),
      output: Schema.String,
      execute: async (args, toolContext) => {
        // ── Capability guard (defense-in-depth) ─────────────────────────
        const cap = tracker.get(toolContext.sessionID);
        if (cap?.multimodal) {
          const id = `${cap.providerID}/${cap.modelID}`;
          return {
            output: `The active primary model (${id}) can process images natively. Use the read tool or respond directly — no delegation needed.`,
            metadata: { mode: "passthrough_redirect", model: id },
          };
        }

        await maybeAutoDetect(cap?.providerID);

        // ── Normalize paths ─────────────────────────────────────────────
        const paths = normalizeImagePaths(args);
        if (paths.length === 0) {
          return {
            output: "describe_image requires image_path or image_paths (got neither).",
            metadata: { error: "no_image_path" },
          };
        }
        if (paths.length > MAX_BATCH_IMAGES) {
          return {
            output: `describe_image received ${paths.length} images; the batch cap is ${MAX_BATCH_IMAGES}. Split across multiple calls.`,
            metadata: { error: "batch_too_large" },
          };
        }

        // ── Load + validate the images ──────────────────────────────────
        const { loaded, unresolved } = detectImages(paths, projectDirectory);
        if (loaded.length === 0) {
          const details = unresolved.map((t) => `[error: not_found — image not found at "${t}"]`).join("\n");
          return {
            output: `Vision tool error: no readable image(s).\n${details || "check the paths and try again."}`,
            metadata: { error: "no_readable_image", unresolved },
          };
        }

        currentConfig = loadConfig();
        cache = syncCache(cache, currentConfig);

        const result = await delegateToVisionModel(
          makeDelegateDeps(toolContext.sessionID),
          currentConfig,
          loaded,
          args.prompt,
          undefined,
          cache,
        );

        if (result.ok) {
          return {
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
          output: result.error.message,
          metadata: { mode: "delegate", error: result.error.code },
        };
      },
    });
  });

  // ── 3. Session context hook: image-path detection + rewriting ───────────
  // The context hook's messages are typed readonly; the hook contract allows
  // in-place rewriting (the host reads the mutated array). Cast to a mutable
  // local view — same array identity, so mutations reach the host.
  type MutablePart = { type: string; text?: string; mediaType?: string; data?: string; filename?: string };
  type MutableUserMessage = { role: string; content: MutablePart[] };
  const sessionReg = await context.session.hook("context", async (ctx) => {
    // Track primary capability + refresh config/cache.
    if (ctx.model) {
      await trackModel(ctx.sessionID, { providerID: ctx.model.providerID, modelID: ctx.model.id });
    }
    await maybeAutoDetect(ctx.model?.providerID);
    currentConfig = loadConfig();
    cache = syncCache(cache, currentConfig);

    // Scan the latest user message's text parts for image path tokens.
    const messages = ctx.messages as MutableUserMessage[];
    const userMessage = [...messages].reverse().find((m) => m.role === "user");
    if (!userMessage) return;
    const textParts = userMessage.content.filter((p): p is MutablePart & { type: "text"; text: string } => p.type === "text");
    if (textParts.length === 0) return;

    const tokens = findImagePathTokens(textParts.map((p) => p.text).join("\n"));
    if (tokens.length === 0) return;

    const cap = tracker.get(ctx.sessionID);
    const multimodal = cap?.multimodal ?? false;

    const { loaded } = detectImages(tokens, projectDirectory);
    if (loaded.length === 0) return;

    // Rewrite the first text part: markers replace the resolved tokens.
    const rewritten = rewriteWithMarkers(textParts[0]!.text, loaded, currentConfig.markerStyle);
    textParts[0]!.text = rewritten;

    // ── MULTIMODAL primary: attach natively + markers (zero delegation) ──
    if (multimodal) {
      const existing = new Set(userMessage.content.filter((p) => p.type === "media").map((p) => p.data));
      for (const img of loaded) {
        if (existing.has(img.dataURL)) continue;
        userMessage.content.push({
          type: "media",
          mediaType: img.mimeType,
          data: img.dataURL,
          filename: img.abs.split("/").pop(),
        });
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
              makeDelegateDeps(ctx.sessionID),
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
  });

  // ── Cleanup: dispose every registration ────────────────────────────────
  return async () => {
    await Promise.allSettled(
      [agentReg, toolReg, sessionReg].map((reg) => (reg ? reg.dispose() : Promise.resolve())),
    );
  };
}
