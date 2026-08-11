/**
 * Unit tests for the pure paste/marker modules (node:test — run via tsx).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { findImagePathTokens, detectImages, rewriteWithMarkers } from "../src/paste";
import { renderMarkers, styleMarker, buildHintLine, buildBatchToolResult, buildDescriptionsBlock } from "../src/marker";
import { cacheKey, VisionCache } from "../src/cache";
import { mergeConfig, DEFAULT_CONFIG, visionConfigPath } from "../src/config";
import { isMultimodal, findModel, findFirstVisionModel, autoDetectVisionModel, listVisionModels } from "../src/capability";
import type { Provider } from "@opencode-ai/sdk";
import { sha256, toDataURL } from "../src/image";

// ── findImagePathTokens ──────────────────────────────────────────────────────

test("findImagePathTokens: absolute POSIX paths", () => {
  assert.deepEqual(
    findImagePathTokens("Look at /tmp/screenshot.png please"),
    ["/tmp/screenshot.png"],
  );
});

test("findImagePathTokens: home + relative + drive paths", () => {
  assert.deepEqual(
    findImagePathTokens("~/shots/a.png ./b.jpeg ../c.gif C:\\d.webp D:/e.bmp"),
    ["~/shots/a.png", "./b.jpeg", "../c.gif", "C:\\d.webp", "D:/e.bmp"],
  );
});

test("findImagePathTokens: relative path with separator", () => {
  assert.deepEqual(findImagePathTokens("check images/shot.png now"), ["images/shot.png"]);
});

test("findImagePathTokens: bare filenames are NOT matched (pi behavior)", () => {
  assert.deepEqual(findImagePathTokens("the word screenshot.png alone"), []);
});

test("findImagePathTokens: escaped spaces from drag-drop", () => {
  assert.deepEqual(findImagePathTokens("open /tmp/my\\ shot.png here"), ["/tmp/my\\ shot.png"]);
});

test("findImagePathTokens: dedup + order preserved", () => {
  assert.deepEqual(
    findImagePathTokens("/a/x.png /a/x.png ./y.png"),
    ["/a/x.png", "./y.png"],
  );
});

// ── detectImages / rewriteWithMarkers ─────────────────────────────────────────

const FIXTURE = join(tmpdir(), `opencode-vision-test-${process.pid}`);
mkdirSync(FIXTURE, { recursive: true });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000156a2d8a60000000049454e44ae426082", "hex");
writeFileSync(join(FIXTURE, "shot.png"), PNG);
writeFileSync(join(FIXTURE, "photo.jpeg"), PNG);

test("detectImages: resolves existing images, flags unresolved", () => {
  const { loaded, unresolved } = detectImages([join(FIXTURE, "shot.png"), "/no/such/img.png"], FIXTURE);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.mimeType, "image/png");
  assert.deepEqual(unresolved, ["/no/such/img.png"]);
});

test("rewriteWithMarkers: substitutes markers, 1-indexed", () => {
  const { loaded } = detectImages([join(FIXTURE, "shot.png")], FIXTURE);
  const text = `see ${loaded[0]!.token} here`;
  const out = rewriteWithMarkers(text, loaded, "code");
  assert.equal(out, "see `[Image-#1]` here");
});

test("renderMarkers: longest-match wins on overlapping tokens", () => {
  const resolved = new Map<string, { index: number }>([
    ["/a/b.png", { index: 0 }],
    ["b.png", { index: 1 }],
  ]);
  const out = renderMarkers("x /a/b.png y", ["/a/b.png", "b.png"], resolved, "plain");
  assert.equal(out, "x [Image-#1] y");
});

// ── marker builders ───────────────────────────────────────────────────────────

test("styleMarker: code/bold/plain", () => {
  assert.equal(styleMarker(1, "code"), "`[Image-#1]`");
  assert.equal(styleMarker(2, "bold"), "**[Image-#2]**");
  assert.equal(styleMarker(3, "plain"), "[Image-#3]");
});

test("buildHintLine: names describe_image + paths", () => {
  const line = buildHintLine([{ token: "/tmp/a.png", index: 0 }, { token: "/tmp/b.png", index: 1 }]);
  assert.match(line, /describe_image/);
  assert.match(line, /image_paths/);
  assert.match(line, /\/tmp\/a\.png/);
});

test("buildBatchToolResult: success + per-image error", () => {
  const out = buildBatchToolResult(["/a.png", "/b.png"], [
    { ok: true, text: "desc", cached: false, fallback: false },
    { ok: false, errorCode: "not_found", message: "missing" },
  ]);
  assert.match(out, /\[Batch: 2 image\(s\)\]/);
  assert.match(out, /\[Image 1\]/);
  assert.match(out, /desc/);
  assert.match(out, /\[error: not_found — missing\]/);
});

test("buildDescriptionsBlock: labels + footer", () => {
  const out = buildDescriptionsBlock(
    [{ token: "/tmp/a.png", index: 0, text: "a blue sky", cached: true }],
    "minimax/MiniMax-M3",
  );
  assert.match(out, /\[`\[Image-#1\]` \/tmp\/a\.png\]: a blue sky/);
  assert.match(out, /minimax\/MiniMax-M3/);
});

// ── cache ────────────────────────────────────────────────────────────────────

test("cacheKey: stable + input-sensitive", () => {
  const k = cacheKey("abc", true, 1568, 85, "prompt", "p/m", undefined);
  assert.equal(k, cacheKey("abc", true, 1568, 85, "prompt", "p/m", undefined));
  assert.notEqual(k, cacheKey("abd", true, 1568, 85, "prompt", "p/m", undefined));
  assert.notEqual(k, cacheKey("abc", true, 1568, 85, "other", "p/m", undefined));
});

test("VisionCache: memory hit + LRU eviction + disk persistence", () => {
  const cache = new VisionCache(undefined, 2);
  cache.set("a", { text: "A", model: "m", storedAt: 1 });
  cache.set("b", { text: "B", model: "m", storedAt: 2 });
  cache.get("a"); // LRU touch → a moves to end
  cache.set("c", { text: "C", model: "m", storedAt: 3 }); // evicts b
  assert.equal(cache.get("a")?.text, "A");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c")?.text, "C");

  const diskPath = join(FIXTURE, "cache.json");
  const c1 = new VisionCache(diskPath, 10);
  c1.set("x", { text: "X", model: "m", storedAt: 1 });
  const c2 = new VisionCache(diskPath, 10);
  assert.equal(c2.get("x")?.text, "X");
});

// ── config ────────────────────────────────────────────────────────────────────

test("mergeConfig: validates + clamps malformed input", () => {
  const cfg = mergeConfig({ provider: "  minimax ", model: "", maxDimension: 99999, textOnlyPasteMode: "nope", enabled: "yes", batchConcurrency: 100 });
  assert.equal(cfg.provider, "minimax");
  assert.equal(cfg.model, undefined);
  assert.equal(cfg.maxDimension, 8000);
  assert.equal(cfg.textOnlyPasteMode, DEFAULT_CONFIG.textOnlyPasteMode);
  assert.equal(cfg.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(cfg.batchConcurrency, 20);
});

test("visionConfigPath: preferred config dir + env override", () => {
  assert.equal(visionConfigPath("/tmp/cfg"), "/tmp/cfg/vision.json");
  assert.ok(visionConfigPath().endsWith("/opencode/vision.json"));
  process.env.OPENCODE_VISION_CONFIG = "/tmp/dev-vision.json";
  assert.equal(visionConfigPath("/tmp/cfg"), "/tmp/dev-vision.json");
  delete process.env.OPENCODE_VISION_CONFIG;
});

// ── image helpers ────────────────────────────────────────────────────────────

test("sha256 + toDataURL round-trip", () => {
  const h = sha256(PNG);
  assert.equal(h.length, 64);
  const url = toDataURL(PNG, "image/png");
  assert.ok(url.startsWith("data:image/png;base64,"));
});

// ── capability / auto-detect ────────────────────────────────────────────────

function provider(id: string, models: Array<[string, boolean]>): Provider {
  const list: Provider["models"] = {};
  for (const [modelID, image] of models) {
    list[modelID] = { id: modelID, capabilities: { input: { image } } } as Provider["models"][string];
  }
  return { id, name: id, source: "custom", env: [], options: {}, models: list };
}

const PROVIDERS = [
  provider("openai", [
    ["gpt-4o", true],
    ["gpt-4o-mini", true],
    ["gpt-4-turbo", false],
  ]),
  provider("minimax", [["MiniMax-M3", true]]),
  provider("local", [["qwen2", false]]),
];

test("isMultimodal: image input flag, safe default for unknown", () => {
  assert.equal(isMultimodal(PROVIDERS[0]!.models["gpt-4o"]), true);
  assert.equal(isMultimodal(PROVIDERS[0]!.models["gpt-4-turbo"]), false);
  assert.equal(isMultimodal(undefined), false);
  assert.equal(isMultimodal({ capabilities: undefined } as unknown as Pick<import("@opencode-ai/sdk").Model, "capabilities">), false);
});

test("findModel: exact provider+model match only", () => {
  assert.equal(findModel(PROVIDERS, "openai", "gpt-4o")?.id, "gpt-4o");
  assert.equal(findModel(PROVIDERS, "openai", "missing"), undefined);
  assert.equal(findModel(PROVIDERS, "nope", "gpt-4o"), undefined);
});

test("findFirstVisionModel: first image-capable model across providers", () => {
  const hit = findFirstVisionModel(PROVIDERS);
  assert.equal(hit?.id, "gpt-4o");
  assert.equal(findFirstVisionModel([provider("x", [["a", false]])]), undefined);
});

test("autoDetectVisionModel: prefers the primary provider's vision model", () => {
  const hit = autoDetectVisionModel(PROVIDERS, "minimax");
  assert.equal(hit?.id, "MiniMax-M3");
});

test("autoDetectVisionModel: falls back to any vision model when the primary provider has none/unknown", () => {
  assert.equal(autoDetectVisionModel(PROVIDERS, "local")?.id, "gpt-4o");
  assert.equal(autoDetectVisionModel(PROVIDERS, "does-not-exist")?.id, "gpt-4o");
  assert.equal(autoDetectVisionModel(PROVIDERS, undefined)?.id, "gpt-4o");
});

test("listVisionModels: preferred provider first, dedup, image-capable only", () => {
  const all = listVisionModels(PROVIDERS);
  assert.deepEqual(all, [
    { providerID: "openai", modelID: "gpt-4o" },
    { providerID: "openai", modelID: "gpt-4o-mini" },
    { providerID: "minimax", modelID: "MiniMax-M3" },
  ]);

  const preferred = listVisionModels(PROVIDERS, "minimax");
  assert.deepEqual(preferred, [
    { providerID: "minimax", modelID: "MiniMax-M3" },
    { providerID: "openai", modelID: "gpt-4o" },
    { providerID: "openai", modelID: "gpt-4o-mini" },
  ]);

  const unknown = listVisionModels(PROVIDERS, "does-not-exist");
  assert.equal(unknown.length, 3);
  assert.equal(listVisionModels([provider("x", [["a", false]])]).length, 0);
});

test("mergeConfig: autoDetected parses booleans, defaults false", () => {
  assert.equal(mergeConfig({}).autoDetected, false);
  assert.equal(mergeConfig({ autoDetected: true }).autoDetected, true);
  assert.equal(mergeConfig({ autoDetected: "yes" }).autoDetected, false);
});
