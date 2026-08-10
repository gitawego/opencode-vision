/**
 * Delegate pipeline tests — fake DelegateClient validates the full subagent
 * delegation flow (cache / local-only / spawn / retry / fallback / abort)
 * without a real opencode server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { delegateToVisionModel, extractTextFromParts, type DelegateClient, type DelegateDeps } from "../src/delegate";
import { VisionCache } from "../src/cache";
import { DEFAULT_CONFIG, type VisionConfig } from "../src/config";
import { loadImage, toDataURL } from "../src/image";
import type { DetectedImage } from "../src/paste";

const FIXTURE = join(tmpdir(), `opencode-vision-delegate-${process.pid}`);
mkdirSync(FIXTURE, { recursive: true });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000156a2d8a60000000049454e44ae426082", "hex");
const IMG_PATH = join(FIXTURE, "a.png");
writeFileSync(IMG_PATH, PNG);

const image: DetectedImage = (() => {
  const r = loadImage(IMG_PATH, FIXTURE);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  return { token: IMG_PATH, abs: r.image.abs, mimeType: r.image.mimeType, data: r.image.data, sourceHash: r.image.sourceHash, dataURL: toDataURL(r.image.data, r.image.mimeType), index: 0 };
})();

const CONFIG: VisionConfig = { ...DEFAULT_CONFIG, provider: "minimax", model: "MiniMax-M3" };
const FALLBACK_CONFIG: VisionConfig = { ...CONFIG, fallbackProvider: "qwen", fallbackModel: "qwen-vl" };

function makeClient(overrides?: {
  promptResponse?: () => { parts: unknown[] };
  /** Return an Error to fail this prompt attempt, or undefined to succeed. */
  promptError?: (attempt: number) => Error | undefined;
  deleteShouldFail?: boolean;
  onCreate?: () => void;
  onPrompt?: () => void;
  onDelete?: () => void;
}): { client: DelegateClient; calls: { creates: number; prompts: number; deletes: number } } {
  const calls = { creates: 0, prompts: 0, deletes: 0 };
  const client = {
    session: {
      create: async (opts: { body: { parentID: string; title?: string } }) => {
        calls.creates++;
        overrides?.onCreate?.();
        return { data: { id: `child-${calls.creates}`, parentID: opts.body.parentID, title: opts.body.title ?? "" } };
      },
      prompt: async () => {
        calls.prompts++;
        overrides?.onPrompt?.();
        if (overrides?.promptError) {
          const err = overrides.promptError(calls.prompts);
          if (err) throw err;
        }
        if (overrides?.promptResponse) {
          const r = overrides.promptResponse();
          return { data: { parts: r.parts } };
        }
        return { data: { parts: [{ type: "text", text: "a fake description" }] } };
      },
      delete: async () => {
        calls.deletes++;
        overrides?.onDelete?.();
        if (overrides?.deleteShouldFail) return { error: new Error("delete failed") };
        return {};
      },
    },
  } as unknown as DelegateClient;
  return { client, calls };
}

function makeDeps(client: DelegateClient): DelegateDeps {
  return {
    client,
    parentSessionID: "parent-1",
    resolveVisionModel: async (providerID, modelID) =>
      ({ providerID, modelID }),
  };
}

// capture prompt bodies for assertions
let promptBodies: Array<{ agent?: string; model?: unknown; parts: unknown[]; signal?: AbortSignal }> = [];
function capturingClient(inner: DelegateClient): DelegateClient {
  const wrap: DelegateClient = {
    session: {
      create: (o) => inner.session.create(o),
      prompt: async (o) => {
        promptBodies.push({ agent: o.body.agent, model: o.body.model, parts: o.body.parts });
        return inner.session.prompt(o as never) as never;
      },
      delete: (o) => inner.session.delete(o),
    },
  };
  return wrap;
}

// ── preflight errors ─────────────────────────────────────────────────────────

test("delegate: not configured → not_configured", async () => {
  const { client } = makeClient();
  const cfg = { ...DEFAULT_CONFIG, provider: undefined, model: undefined };
  const r = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "not_configured");
  assert.equal(promptBodies.length, 0);
});

test("delegate: disabled → disabled", async () => {
  const { client } = makeClient();
  const cfg = { ...CONFIG, enabled: false };
  const r = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "disabled");
});

test("delegate: model not found → model_not_found", async () => {
  const { client } = makeClient();
  const deps: DelegateDeps = { ...makeDeps(client), resolveVisionModel: async () => undefined };
  const r = await delegateToVisionModel(deps, CONFIG, [image], "prompt", undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "model_not_found");
});

// ── cache ────────────────────────────────────────────────────────────────────

test("delegate: full cache hit → zero spawns", async () => {
  const { client, calls } = makeClient();
  const cache = new VisionCache(undefined, 64);
  const { cacheKey } = await import("../src/cache");
  const realKey = cacheKey(image.sourceHash, true, CONFIG.maxDimension, CONFIG.jpegQuality, "prompt", "minimax/MiniMax-M3", CONFIG.systemPrompt);
  cache.set(realKey, { text: "cached desc", model: "minimax/MiniMax-M3", storedAt: 1 });

  const r = await delegateToVisionModel(makeDeps(client), CONFIG, [image], "prompt", undefined, cache);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.text, /cached desc/);
  assert.equal(r.details.cached, true);
  assert.equal(calls.creates, 0);
  assert.equal(calls.prompts, 0);
});

// ── local-only ───────────────────────────────────────────────────────────────

test("delegate: local-only refuses on miss, allows cache hit", async () => {
  const { client, calls } = makeClient();
  const cache = new VisionCache(undefined, 64);
  const cfg = { ...CONFIG, localOnly: true };

  // miss → refuse, zero spawns
  const miss = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", undefined, cache);
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.error.code, "local_only");
  assert.equal(calls.creates, 0);

  // hit → allowed (cache is local)
  const { cacheKey } = await import("../src/cache");
  const key = cacheKey(image.sourceHash, true, cfg.maxDimension, cfg.jpegQuality, "prompt", "minimax/MiniMax-M3", cfg.systemPrompt);
  cache.set(key, { text: "cached", model: "minimax/MiniMax-M3", storedAt: 1 });
  const hit = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", undefined, cache);
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.equal(hit.details.cached, true);
  assert.equal(calls.creates, 0);
});

// ── spawn + extract ──────────────────────────────────────────────────────────

test("delegate: spawns child session, attaches image data URL, extracts text, deletes child", async () => {
  promptBodies = [];
  const { client, calls } = makeClient();
  const deps = makeDeps(capturingClient(client));

  const r = await delegateToVisionModel(deps, CONFIG, [image], "what color?", undefined);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.text, "a fake description");
  assert.equal(calls.creates, 1);
  assert.equal(calls.prompts, 1);
  assert.equal(calls.deletes, 1);

  const body = promptBodies[0]!;
  assert.equal(body.agent, "vision");
  assert.deepEqual(body.model, { providerID: "minimax", modelID: "MiniMax-M3" });
  assert.equal(body.parts.length, 2);
  const filePart = body.parts[0] as { type: string; mime: string; url: string };
  assert.equal(filePart.type, "file");
  assert.equal(filePart.mime, "image/png");
  assert.ok(filePart.url.startsWith("data:image/png;base64,"));
});

test("delegate: batch of 2 → single spawn with both images attached", async () => {
  promptBodies = [];
  const second = { ...image, abs: IMG_PATH.replace("a.png", "b.png"), index: 1 };
  const { client, calls } = makeClient();
  const deps = makeDeps(capturingClient(client));

  const r = await delegateToVisionModel(deps, CONFIG, [image, second], "compare", undefined);
  assert.equal(r.ok, true);
  assert.equal(calls.prompts, 1);
  const body = promptBodies[0]!;
  assert.equal(body.parts.filter((p) => (p as { type: string }).type === "file").length, 2);
});

// ── retry + fallback ─────────────────────────────────────────────────────────

test("delegate: retries transient failure then succeeds", async () => {
  const { client, calls } = makeClient({
    promptError: (attempt) => (attempt === 1 ? new Error("fetch failed: ECONNREFUSED") : undefined),
  });
  const cfg = { ...CONFIG, retryAttempts: 2, retryBackoffMs: 1 };
  const r = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", undefined);
  assert.equal(r.ok, true);
  assert.equal(calls.prompts, 2); // one failed + one success
});

test("delegate: falls back to configured model on failure", async () => {
  promptBodies = [];
  const { client, calls } = makeClient({
    promptError: (attempt) => (attempt <= 3 ? new Error(`HTTP 500: boom (attempt ${attempt})`) : undefined),
  });
  const deps = makeDeps(capturingClient(client));
  const r = await delegateToVisionModel(deps, FALLBACK_CONFIG, [image], "prompt", undefined);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.details.fallback, true);
  assert.equal(r.details.model, "qwen/qwen-vl");
  // primary retries (3 attempts) + fallback (1 attempt)
  assert.equal(calls.prompts, 4);
  const last = promptBodies.at(-1)!;
  assert.deepEqual(last.model, { providerID: "qwen", modelID: "qwen-vl" });
});

test("delegate: abort stops retries", async () => {
  const controller = new AbortController();
  let promptCalls = 0;
  const { client } = makeClient({
    promptError: () => {
      promptCalls++;
      controller.abort();
      return new Error("fetch failed");
    },
  });
  const cfg = { ...CONFIG, retryAttempts: 3, retryBackoffMs: 1 };
  const r = await delegateToVisionModel(makeDeps(client), cfg, [image], "prompt", controller.signal);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "aborted");
  assert.equal(promptCalls, 1);
});

// ── extractTextFromParts ─────────────────────────────────────────────────────

test("extractTextFromParts: joins text parts, skips reasoning", () => {
  const text = extractTextFromParts([
    { type: "reasoning", text: "hmm" },
    { type: "text", text: "first" },
    { type: "step-start" },
    { type: "text", text: "second" },
  ] as never);
  assert.equal(text, "first\nsecond");
});

test("extractTextFromParts: undefined/empty → undefined", () => {
  assert.equal(extractTextFromParts(undefined), undefined);
  assert.equal(extractTextFromParts([]), undefined);
  assert.equal(extractTextFromParts([{ type: "text", text: "   " }] as never), undefined);
});
