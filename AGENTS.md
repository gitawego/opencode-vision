<!-- Satellite context file — host-neutral; project-specific only. -->

# @gitawego/opencode-vision

> Capability-aware vision + paste plugin for opencode. npm: `@gitawego/opencode-vision`.

## What

Detects image file paths in user messages and makes them usable by the active
primary model:

- **Multimodal primary** → `[Image-#N]` markers + native attachment. Zero
  delegation.
- **Text-only primary** → markers + hint (or auto-description); the model
  delegates via `describe_image`, which spawns a hidden `vision` subagent
  running the configured vision-capable model (e.g. MiniMax-M3).

Delegation is an opencode **subagent** (child `session.prompt`), not an HTTP
call — the whole point is to reuse opencode's model/auth infra.

## Structure

```
src/server/index.ts   server plugin: config hook (vision agent), chat.message,
                      describe_image tool, event
src/tui/index.tsx     TUI plugin: settings menu (DialogSelect cascade),
                      /vision command, ctrl+shift+i model picker
src/config.ts         vision.json load/save (shared server+TUI)
src/paste.ts          path detection + marker rewriting (pure)
src/marker.ts         markers + hint + batch result + descriptions (pure)
src/delegate.ts       subagent spawn + cache/retry/fallback/local-only/audit
src/cache.ts          content-addressed cache (memory + disk LRU)
src/capability.ts     isMultimodal + per-session capability tracker
test/                 node:test (tsx) — pure + fake-client delegate suites
SPEC.md               design + porting matrix + validation items
```

## Common Commands

```bash
npm install
npm run typecheck   # node node_modules/typescript/bin/tsc --noEmit (Termux has no /usr/bin/env)
npm test            # node --import tsx --test test/pure.test.ts test/delegate.test.ts
```

## Notes

- **One package, two entries.** The opencode loader rejects a single file
  exporting both `server` and `tui`. `package.json` exposes `exports["./server"]`
  and `exports["./tui"]`; the loader resolves per-kind. Local install:
  `{ "plugin": ["/abs/path/to/opencode-vision"] }` in opencode.json.
- **TUI JSX** uses SolidJS via `@opentui/solid/jsx-runtime` (`@jsxImportSource`
  pragma at the top of `src/tui/index.tsx`).
- **Config path parity.** TUI writes via `api.state.path.config`; server reads
  via `XDG_CONFIG_HOME` → `~/.config/opencode`. `OPENCODE_VISION_CONFIG`
  overrides (dev).
- **Mechanism A (hide tool per model) is not supported** in opencode — the tool
  is always registered; `execute` returns a redirect on multimodal primaries.
- Validation items (live restart needed) are tracked in SPEC.md §11.

## Engineering principles

- Do not preserve backward compatibility; remove obsolete paths instead of
  adding compatibility layers.
- Choose the simplest implementation that fully meets current requirements.
- Grow in layers: ship the smallest working version, then add capabilities.
- Prefer opencode's own mechanisms (subagent, model registry, provider auth)
  before writing bespoke code.
