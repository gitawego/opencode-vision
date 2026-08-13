/**
 * opencode-vision — v2 adapter tests (fake plugin Context).
 *
 * Drives `setup()` from src/v2.ts with an in-memory plugin Context (the v2
 * promise-domain surface) and asserts the v2 contract:
 *  1. the describe_image tool is registered via tool.transform
 *  2. the session context hook is registered
 *  3. the context hook rewrites image-path tokens into markers + hint
 *  4. the tool execute delegates through the v2 session API (create →
 *     prompt → generate) and returns the analysis text
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { deflateSync } from "node:zlib";
import { setup } from "../src/v2";

function makePng(path: string, w = 8, h = 8): void {
  // Minimal valid PNG (RGBA8) — enough for detectImages (magic + IHDR parse).
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const dir = mkdtempSync(join(tmpdir(), "ocv-v2-test-"));
const imgPath = join(dir, "shot.png");
let cleanup: (() => Promise<void>) | undefined;
let registeredTools: Array<Record<string, unknown>> = [];
let sessionHooks: Record<string, (...args: unknown[]) => Promise<void> | void> = {};
let createdSessions: Array<Record<string, unknown>> = [];
let prompted: Array<Record<string, unknown>> = [];

const visionConfigPath = join(dir, "vision.json");
writeFileSync(
  visionConfigPath,
  JSON.stringify({
    provider: "minimax-cn",
    model: "MiniMax-M3",
    enabled: true,
    textOnlyPasteMode: "hint",
    markerStyle: "code",
    autoDetectVisionModel: false,
  }),
);
process.env.OPENCODE_VISION_CONFIG = visionConfigPath;

before(async () => {
  makePng(imgPath);
  const fakeContext = {
    agent: {
      transform: (cb: (draft: { get: (id: string) => unknown }) => void) => {
        cb({ get: () => undefined });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: (cb: (draft: { add: (tool: unknown) => void }) => void) => {
        cb({ add: (tool) => registeredTools.push(tool as Record<string, unknown>) });
        return { dispose: async () => {} };
      },
    },
    session: {
      create: async (input: unknown) => {
        createdSessions.push(input as Record<string, unknown>);
        return { id: "ses_v2_test_child" };
      },
      prompt: async (input: unknown) => {
        prompted.push(input as Record<string, unknown>);
        return { id: "msg_v2_test", type: "user" };
      },
      generate: async () => ({ data: { text: "A red test image." } }),
      remove: async () => {},
      hook: (name: string, cb: (...args: unknown[]) => Promise<void> | void) => {
        sessionHooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    catalog: {
      provider: {
        list: async () => ({
          data: [
            {
              id: "primary",
              models: {
                "text-only": { id: "text-only", capabilities: { input: ["text"] } },
              },
            },
            {
              id: "minimax-cn",
              models: {
                "MiniMax-M3": { id: "MiniMax-M3", capabilities: { input: ["text", "image"] } },
              },
            },
          ],
        }),
      },
    },
  };

  cleanup = await setup(fakeContext as never);
});

after(async () => {
  await cleanup?.();
  delete process.env.OPENCODE_VISION_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

test("v2: registers the describe_image tool", () => {
  const tool = registeredTools.find((t) => t.name === "describe_image");
  assert.ok(tool, "describe_image tool not registered");
  assert.equal(typeof (tool as { execute?: unknown }).execute, "function");
});

test("v2: registers the session context hook", () => {
  assert.equal(typeof sessionHooks.context, "function");
});

test("v2: context hook rewrites image paths into markers + hint", async () => {
  const ctx = {
    sessionID: "ses_v2_test",
    agent: "primary",
    model: { id: "text-only", providerID: "primary" },
    system: [],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `look at ${imgPath}` }],
      },
    ],
    tools: {},
  };
  await sessionHooks.context!(ctx);
  const text = ctx.messages[0]!.content[0]!.text as string;
  // The inline token is replaced by a marker; the hint block then re-lists the
  // resolved paths for the user (v1-identical behavior) — so check the marker
  // replaced the token position, not that the path is absent entirely.
  assert.ok(!text.startsWith("look at /"), "inline image path should be replaced by a marker");
  assert.match(text, /\[Image-#1\]/, "marker should reference the image");
  assert.match(text, /describe_image/m, "hint line should mention describe_image");
});

test("v2: tool execute delegates via the v2 session API", async () => {
  const tool = registeredTools.find((t) => t.name === "describe_image") as {
    execute: (input: unknown, context: unknown) => Promise<{ output?: string; metadata?: Record<string, unknown> }>;
  };
  const result = await tool.execute(
    { image_path: imgPath, prompt: "describe" },
    { sessionID: "ses_v2_test", agent: "primary", messageID: "msg1", id: "call1", progress: async () => {} },
  );
  assert.equal(result.output, "A red test image.");
  assert.equal(result.metadata?.mode, "delegate");
  assert.equal(createdSessions.length, 1, "delegation should create one child session");
  const promptInput = prompted[0] as { sessionID?: string; text?: { files?: unknown[] } };
  assert.equal(promptInput.sessionID, "ses_v2_test_child");
  assert.equal((promptInput.text as { files?: unknown[] }).files?.length, 1, "image should travel as a prompt file");
});
