# @gitawego/opencode-vision

> Capability-aware vision + paste plugin for [opencode](https://opencode.ai).

`opencode-vision` makes image files referenced in your messages **usable** by
the active model — and never wastes a call:

- **Multimodal primary** (e.g. MiniMax-M3, GPT-5 vision) → image paths in your
  message are rewritten to `[Image-#N]` markers and the images are attached
  natively. Zero delegation, zero extra tokens.
- **Text-only primary** → the message gets markers + a hint (or an automatic
  description) and the model delegates to a configured **vision-capable model**
  through a hidden opencode **subagent** (the `vision` agent), not a hand-rolled
  HTTP call.

Ported from the pi extension [`@gitawego/vision`](https://github.com/gitawego/vision).

## Features

- **Paste UX.** Paths (absolute `/…`, home `~/…`, relative `./…`, Windows
  `C:\…`, drag-and-drop escaped spaces) → `[Image-#N]` markers.
  - Multimodal primary → native attachment.
  - Text-only primary → `hint` (zero-token nudge), `auto` (auto-describe, timeout
    protected, concurrency-bounded), or `off` (markers only).
- **`describe_image` tool.** Single (`image_path`) or batch (`image_paths`,
  up to 50) analysis with one subagent turn. Returns structured text.
- **Subagent delegation.** A hidden `vision` subagent runs the configured
  vision model in a child session; the images travel as data URLs so the model
  sees them natively. Retry (5xx/429/network, backoff), configurable fallback
  model, abort-aware.
- **Settings menu (TUI).** `/vision`, the command palette (`Vision settings`),
  or `ctrl+shift+m` opens a dialog-based panel — model picker (auto-lists
  vision-capable models), paste mode, marker style, local-only, cache,
  concurrency, and more. `ctrl+shift+i` is the quick model picker.
- **Capability-aware by default.** Auto-detects a vision-capable model when
  none is configured. On a multimodal primary, `describe_image` refuses with a
  redirect instead of delegating.
- **Cache.** Content-addressed (`sha256(bytes)` + prompt + model), memory +
  optional disk LRU. A repeat call costs zero subagent spawns.
- **Audit log.** Every delegation is recorded as one JSONL line in
  `~/.config/opencode/vision-audit.log` (routing only — image bytes are never
  logged, only a `source_hash` fingerprint). Opt-out.
- **Local-only mode.** Image bytes never leave the machine; cache hits still
  work, a miss refuses with a clear error.

## Install

> **Requires opencode ≥ 1.18** (TUI plugin support). Loads the `./server` and
> `./tui` package entries automatically. Plugins load at opencode startup —
> **restart opencode** after installing.

**One command installs both entries** (server + TUI settings page):

```bash
opencode plugin /path/to/opencode-vision -g
```

This is fully transparent: opencode surgically inserts the plugin into the
`plugin` array of **both** `opencode.json` and `tui.json` (global config),
preserving every other setting and comment, and skips files where the plugin
is already present. The in-TUI plugin manager (`/plugins` → install) does the
same. Re-running is a no-op.

Why both files? opencode loads the two entries from different config files:

- The **server** entry (image detection, `describe_image`, subagent delegation)
  loads from the `plugin` array in `opencode.json`.
- The **TUI** entry (the `/vision` settings page, `ctrl+shift+m` hotkeys) loads
  from the `plugin` array in `tui.json` (global `~/.config/opencode/tui.json`,
  or a project-local `tui.json` / `.opencode/tui.json`).

If the plugin only appears in `opencode.json`, opencode starts and image
handling works, but there is **no settings page** (`/vision` won't exist).

**From git (the pi `install git:...` equivalent):**

```bash
opencode plugin github:gitawego/opencode-vision -g   # install + write to global opencode.json
opencode plug github:gitawego/opencode-vision        # alias; -f to force-replace a pinned version
```

or list the git spec in `opencode.json` directly (a `#tag`/`#commit` pin works):

```jsonc
{ "plugin": ["github:gitawego/opencode-vision#v0.1.0"] }
```

> The loader passes non-path specs to `@npmcli/arborist` (npm-package-arg), so
> `github:user/repo`, `git+https://github.com/user/repo.git`, bare `user/repo`,
> and `#committish` pins all work. This is **undocumented upstream** — the
> officially documented methods are npm packages and local files — so treat git
> install as experimental.

**From a local checkout (dev):**

```jsonc
// opencode.json
{ "plugin": ["/path/to/opencode-vision"] }
```

**From npm (once published):**

```jsonc
{ "plugin": ["@gitawego/opencode-vision"] }
```

## Configure

Everything is configurable from the settings menu (no manual file editing
needed):

| Action | How |
|---|---|
| Open settings | `/vision` or command palette → "Vision settings" or `ctrl+shift+m` |
| Pick vision model | Settings → "Vision model", or `ctrl+shift+i` |
| Paste behavior on text-only primaries | Settings → "Paste mode" (`hint`/`auto`/`off`) |
| Local-only / audit / cache / concurrency | Settings menu |
| Reset | Settings → "Clear config" |

Config is stored at `~/.config/opencode/vision.json`. `OPENCODE_VISION_CONFIG`
overrides the path (dev convenience).

## Using `describe_image`

On a text-only primary the model can analyze images directly:

```
describe_image(image_path: "/tmp/screenshot.png", prompt: "What's in this image?")
describe_image(image_paths: ["/tmp/a.png", "/tmp/b.png"], prompt: "Compare these.")
```

On a multimodal primary you don't need the tool — just reference the path and
the image is attached natively.

## How it works

1. **Server** (`config` hook) registers the hidden `vision` subagent and
   auto-detects a vision-capable model.
2. **Paste hook** (`chat.message`) rewrites image paths into `[Image-#N]`
   markers and, for multimodal primaries, attaches them as native file parts.
3. **Delegation** (`describe_image` or auto mode) spawns a child opencode
   session running the `vision` agent with the vision model; images are attached
   as data-URL file parts. The description is returned as the tool result.
4. **TUI** provides the settings menu + commands.

`describe_image` is always registered (opencode plugins can't hide a tool per
model). For multimodal primaries its `execute` detects the active model's
capability at runtime and returns a "respond directly" redirect instead of
delegating.

## Verification checklist (after restart)

1. `opencode` starts with no plugin errors:
   `grep -iE "opencode-vision|vision" ~/.local/share/opencode/log/opencode.log | grep -iE "error|fail"` → empty.
2. `/vision` opens the settings menu; pick a vision model from the list.
3. Reference an image path in a message (e.g. `/tmp/screenshot.png`) on a
   text-only primary → the message gains markers + a hint, and the model can
   call `describe_image`.
4. Check `~/.config/opencode/vision-audit.log` for delegation entries.

## Project layout

```
src/server/index.ts   server plugin: hooks + describe_image tool
src/tui/index.tsx     TUI plugin: settings menu, commands, hotkey
src/…                 pure modules (config, paste, marker, cache, delegate, …)
test/                 node:test suites (30 tests, fake-client delegate tests)
SPEC.md               design + porting matrix + validation items
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test
```

## Credits

Forked design from [`getpipher/vision`](https://github.com/getpipher/vision)
→ `@gitawego/vision` (pi) — the code, config shape and behavior originate
there. This is the opencode plugin API port with subagent-based delegation.

## License

MIT
