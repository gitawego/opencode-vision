/**
 * Server plugin hook contract tests.
 *
 * Regression guard for the startup deadlock: the plugin `config` hook runs
 * during opencode's core init, so it MUST NOT issue client RPCs — a response
 * can never be delivered at that point, so the await never resolves and
 * opencode hangs before the TUI renders (silent, no error logged). Vision
 * model auto-detection is deferred to first real use (maybeAutoDetect →
 * chat.message / describe_image) where the client is ready.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginModule from "../src/server/index";

test("config hook registers the vision agent without any client RPC", async () => {
  const calls: string[] = [];
  const spyClient = new Proxy(
    {},
    {
      get(_target, prop) {
        return (..._args: unknown[]) => {
          calls.push(String(prop));
          return Promise.resolve({ data: undefined, error: undefined });
        };
      },
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "ocv-hook-"));

  const hooks = await pluginModule.server({ client: spyClient as never, directory: dir } as never);

  const cfg: Record<string, Record<string, unknown> | undefined> = {};
  await hooks.config!(cfg as never);

  assert.ok(cfg.agent, "config hook must register the vision agent");
  assert.equal((cfg.agent!.vision as { mode?: string })?.mode, "subagent");
  assert.deepEqual(
    calls,
    [],
    "config hook must not call the client — client RPCs here deadlock opencode at startup",
  );
});
