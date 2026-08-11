# opencode-vision — SPEC

> Capability-aware vision + paste plugin for [opencode](https://opencode.ai).
> A port of the pi `@gitawego/pi-vision` extension to the opencode plugin API, with
> delegation done through an opencode **subagent** running a vision-capable model
> (e.g. `MiniMax-M3`) instead of a hand-rolled HTTP call.

Status: **v1 implemented** — server + TUI entries, settings menu, delegation.

---

## 0. Custom plugin menu — the opencode answer

opencode supports custom plugin menus through a **TUI plugin entry point**
(`@opencode-ai/plugin/tui`, shipped since 1.18.x). A plugin package ships TWO
entries (the loader resolves per-kind subpath exports):

```
exports["./server"]  → default export { id, server }  (hooks + tool)
exports["./tui"]     → default export { id, tui }     (menus, commands, keybinds)
```

A single file must export **either** `server` or `tui` (the loader throws on
both). The TUI plugin API (`TuiPluginApi`) provides:

| Need | API |
|---|---|
| Settings menu | `api.ui.dialog` stack + `api.ui.DialogSelect` / `DialogAlert` / `DialogConfirm` / `DialogPrompt` |
| Custom screens | `api.route.register` + `api.route.navigate` (SolidJS routes) |
| Commands (slash + palette) | legacy `api.command.register` (`slash: { name }`, `onSelect`, `keybind`) or `api.keymap.registerLayer` |
| Hotkeys | `keybind` / keymap `bindings` (e.g. `ctrl+shift+i`) |
| Persistent plugin store | `api.kv` |
| Config dir / providers | `api.state.path.config`, `api.state.provider` (with model capabilities) |
| Toasts | `api.ui.toast` |
| Compose-input control | `api.ui.Prompt` refs / `slots` (roadmap: compose preview) |

Settings are written to the SAME `vision.json` the server reads (resolved via
`api.state.path.config`), so TUI changes apply to the server immediately.


## 1. Problem

The opencode TUI lets you reference image files by path in a message
(`/tmp/screenshot.png`), but:

- A **text-only primary model** cannot see those images at all — the bytes are
  never attached.
- A **multimodal primary model** can see them, but only if the images reach the
  model as attachments.

pi-vision solved this for pi with two mechanisms: a capability-aware
`describe_image` tool and a capability-aware paste hook. This project does the
same for opencode, delegating image analysis to a **subagent** whose model is
vision-capable.

## 2. Goals / Non-goals (v1)

### Goals

1. Detect image file paths referenced in a user message.
2. Rewrite the message so the image is *usable* by the active primary model:
   - **Multimodal primary** → attach the image natively (zero delegation).
   - **Text-only primary** → make the image available for delegation via a
     `describe_image` tool; optionally auto-delegate on paste.
3. Delegate image analysis to a vision-capable model through an opencode
   **subagent** (`session.prompt` on a child session with a model override) —
   not a direct provider HTTP call.
4. Capability-aware at runtime: on a multimodal primary the delegation tool
   refuses with a redirect (defense-in-depth) instead of wasting a call.
5. Resilience: content-addressed cache, batch support, timeout protection.

### Non-goals (v1)

- **No custom TUI route/solid panel** for settings — the host-driven
  `DialogSelect` cascade is used instead (robust, host-handled navigation).
- **No client-side image compression/resizing.** Images are attached as-is via
  data URLs; providers downscale server-side. (Roadmap: `@napi-rs/canvas` /
  sharp resize + re-encode.)
- **No compose-preview** (roadmap: `ui.Prompt` ref / `slots`).
- **No slash-command settings on the server side** — the TUI owns the menu.
- **No audit-log panel** — the log exists; viewing is via `cat`/`tail`.

## 3. Porting matrix — pi-vision → opencode

| pi-vision concept | opencode equivalent | Feasible |
|---|---|---|
| `describe_image` tool registration | `tool` hook (`tool({description,args,execute})`) | ✅ shipped |
| Capability check `model.input.includes("image")` | `Model.capabilities.input.image`; resolve `{providerID,modelID}` → `Model` via `client.config.providers()` | ✅ shipped |
| Paste hook (detect image paths, rewrite message) | `chat.message` hook — mutate `output.parts: Part[]`; swap path text → `FilePart` | ✅ shipped |
| Delegate to vision model | hidden `vision` subagent (registered via `config` hook); `describe_image` spawns it via `client.session.create({parentID})` + `client.session.prompt({agent, model, parts})` | ✅ shipped |
| Auto-delegate pasted images | `chat.message` awaits the subagent per image (concurrency-bounded, timeout) then appends descriptions | ✅ shipped |
| `/vision` settings panel (`SettingsList`) | **TUI plugin** (`api.ui.dialog` + `DialogSelect` cascade) + `/vision` slash command + palette entries | ✅ shipped |
| Model picker / inline switch (`ctrl+shift+i`) | TUI `DialogSelect` over `api.state.provider`; legacy `command` `keybind: "ctrl+shift+i"` | ✅ shipped |
| `/vision show` / `clear` subcommands | TUI commands (`Vision: show status`, `Vision: clear config`) | ✅ shipped |
| Resilience (cache / retry / fallback / custom system prompt) | `cache.ts` (content-addressed, memory+disk LRU) + delegate retry/fallback + `systemPrompt` prepended | ✅ shipped |
| Audit log + local-only mode | `audit.ts` (JSONL, routing only) + local-only gate in delegate | ✅ shipped |
| **Mechanism A: hide tool from multimodal models** (`pi.setActiveTools()`) | **No equivalent** — plugin tools are always registered | ⚠️ runtime redirect in `execute` |
| Compose-time preview (`widget` above editor) | TUI `ui.Prompt` refs / `slots` | 🔜 roadmap |
| Client-side compression (`max-dim`/`quality`) | none (providers downscale) | 🔜 roadmap |

### The one real gap (Mechanism A)

opencode plugins cannot toggle tool visibility per active model. Mitigation
(mirrors pi-vision's own defense-in-depth branch):

- The tool description explicitly says: *only call when your model cannot
  process images natively*.
- `describe_image.execute` looks up the session's effective model; if it is
  multimodal it returns `"You can see this image natively — respond directly"`
  with zero delegation.

## 4. Architecture

### 4.0 Package layout (dual entry)

```
src/
  config.ts        vision.json load/save, defaults (shared by server + TUI)
  capability.ts    isMultimodal + model resolution + session capability tracker
  image.ts         mime detection, data URL, sha256, loadImage
  marker.ts        markers + hint + batch result + descriptions (pure)
  paste.ts         image-path detection + marker rewriting (pure)
  cache.ts         content-addressed delegation cache (memory + disk LRU)
  audit.ts         JSONL audit log (routing only)
  delegate.ts      subagent spawn (session.create + session.prompt) + resilience
  server/index.ts  default export { id, server } — hooks + describe_image tool
  tui/index.tsx    default export { id, tui } — settings menu + commands + hotkey
```

### 4.1 Hooks used

| Hook | Purpose |
|---|---|
| `config` (server) | Register the hidden `vision` subagent; auto-detect a vision-capable model |
| `chat.message` (server) | Detect image paths in the user's text parts; rewrite them (markers + native attach / hint / auto-delegate); track per-session capability |
| `tool` (server) | Register `describe_image` |
| `event` (server) | Clean up the capability tracker on `session.deleted` |
| TUI plugin | Settings menu (dialogs), `/vision` command, `ctrl+shift+i` model picker, status/clear commands |

### 4.2 Settings menu (TUI plugin)

Opened via `/vision`, the command palette (`Vision settings`), or `ctrl+shift+m`.
Implemented as a host-driven `DialogSelect` cascade (keyboard nav, filtering and
Escape/back are provided by the host — no custom key handling):

1. **Main menu** lists every setting with its current value as the row title.
2. Selecting a row replaces the dialog with a sub-`DialogSelect` (enum / toggle /
   the vision-model picker).
3. A selection applies the change to `vision.json` (atomic write), toasts
   "Settings saved", and re-opens the main menu.

The model picker enumerates vision-capable models from `api.state.provider`
(`capabilities.input.image`). `ctrl+shift+i` opens the picker directly.

## 5. Message rewrite (paste hook) — `chat.message`

The hook receives `{ sessionID, agent, model:{providerID,modelID}, messageID }`
and an `output` with `{ message, parts }`. It mutates `output.parts`.

### 5.1 Path detection

Scan every `type: "text"` part for path tokens that end in an image extension:

```
.png .jpg .jpeg .gif .webp .bmp .svg .avif .ico
```

Accepted forms (ported from pi-vision, minus Windows we can keep cheaply):

- POSIX absolute `/…`, home `~/…`, relative `./…`, `../…`, bare `…/…`
- Escaped spaces from terminal drag-and-drop (`path\ with\ spaces/x.png`)

Each match is resolved against the session directory (plugin `directory`,
fallback `process.cwd()`). A match whose file does not exist on disk is still
markerized but flagged `not found` and never attached.

### 5.2 Rewrite output, by primary capability

The primary model's capability comes from `input.model` resolved against
`client.config.providers()`.

**Multimodal primary — native pass-through:**

- Replace the path token with `[Image-#N]` (1-indexed, stable per message).
- Push a `FilePart { type:"file", mime, url: dataURL }` into `output.parts`.
  The image now reaches the model natively. Zero delegation.

**Text-only primary — delegation affordance:**

- Replace the path token with `[Image-#N]`.
- No attachment (a text-only model can't consume image content).
- Mode `hint` (default): append one hint line listing the resolved paths and
  naming the `describe_image` tool + `image_paths` batch affordance.
- Mode `auto`: auto-delegate each image via the §6 pipeline (concurrency-
  bounded, one overall AbortController with timeout), then append the
  descriptions to the message text. On timeout/failure fall back to the hint.
- Mode `off`: markers only, no hint, no delegation.

### 5.3 Dedup

Deduplicate by resolved absolute path within a message (first occurrence wins).

## 6. `describe_image` tool

Registered via the `tool` hook (zod args):

| Param | Type | Notes |
|---|---|---|
| `image_path` | string? | single image |
| `image_paths` | string[]? | batch (comparison / cross-reference), cap 50 |
| `prompt` | string | what to analyze; for batches, applies to all |
| `compress` | boolean? | **ignored in v1** (no client-side compression); accepted for forward-compat |

### 6.1 Execution flow

1. **Capability guard.** Look up the session's primary model. If multimodal →
   return a redirect result (`use native — respond directly`), zero delegation.
2. **Normalize paths** (`image_path` + `image_paths`, tolerate JSON-stringified
   arrays, dedup, cap 50, resolve against `ToolContext.directory`).
3. **Cache check.** For each image compute `sha256(bytes)`; the delegation key is
   `hash(image) + prompt + provider/model + systemPrompt`. A full hit returns
   the cached text (0 subagent spawns).
4. **Spawn the vision subagent** (see §7) with all images attached as data-URL
   file parts + the prompt. One subagent turn handles a whole batch — the vision
   model compares the attached images natively. Abort is wired to
   `ToolContext.abort`.
5. **Extract** the assistant text from the child-session response and return it
   as the tool result. Batch failures degrade to per-image `[error: …]`
   sections; `isError` only when every image failed.
6. **Cache write** on success.

## 7. Vision subagent (delegation)

### 7.1 Agent registration (`config` hook)

```ts
config.agent.vision = {
  description: "Reads and describes images using a vision-capable model",
  mode: "subagent",
  hidden: true,                    // out of the @-menu; Task-tool callable
  model: `${provider}/${model}`,   // auto-detected; overridden at prompt time
  prompt: "You are a vision analysis agent. Analyze the image(s) attached to your message and answer the user's question. Return ONLY your analysis text. Do not use tools.",
  permission: { read: "allow", bash: "deny", edit: "deny", webfetch: "deny", task: "deny" },
}
```

### 7.2 Spawn (in `delegate.ts`)

```ts
const child = await client.session.create({ body: { parentID, title: "vision" } })
const res = await client.session.prompt({
  path: { id: child.id },
  body: {
    agent: "vision",
    model: { providerID, modelID },   // hard override → MiniMax-M3 etc.
    parts: [
      ...images.map(img => ({ type: "file", mime: img.mime, url: img.dataURL })),
      { type: "text", text: prompt },
    ],
  },
  ...(abort ? { query: undefined, signal } : {}),
})
// res.parts → text parts → joined description
```

- Images travel as **data URLs** — self-contained, immune to
  child-session directory / external-directory permission issues, and byte
  exact for the cache hash.
- The subagent has nearly all tools denied, so it answers in one turn (minimal
  latency/tokens).

### 7.3 Model resolution order

1. Explicit `provider`/`model` from `vision.json`.
2. Auto-detected model (first `capabilities.input.image` model in
   `client.config.providers()`, prefer the active primary provider when known).
3. Error with a clear message if none exists.

## 8. Capability tracking

- `isMultimodal(m)` = `!!m.capabilities?.input?.image` (mirrors pi-vision's
  safe default: unknown → treat as text-only → show delegation path).
- `chat.message` updates a `Map<sessionID, {providerID, modelID, multimodal}>`
  used by `describe_image.execute` (the `ToolContext` does not carry the model).

## 9. Config (`~/.config/opencode/vision.json`)

Written by the TUI settings menu (path resolved via `api.state.path.config`);
read by the server (path resolved via `XDG_CONFIG_HOME` → `~/.config/opencode`,
which matches). `OPENCODE_VISION_CONFIG` overrides the path (dev convenience).

```jsonc
{
  "enabled": true,
  "provider": "minimax",          // null → auto-detect
  "model": "MiniMax-M3",          // null → auto-detect
  "systemPrompt": null,           // optional framing prepended to the vision prompt
  "textOnlyPasteMode": "hint",    // "hint" | "auto" | "off"
  "autoDelegateTimeoutMs": 30000,
  "cacheEnabled": true,
  "cachePersist": false,
  "cacheMaxEntries": 256,
  "batchConcurrency": 5,          // auto-mode paste parallelism (1–20)
  "localOnly": false,
  "auditLog": true,
  "autoDetectVisionModel": true
}
```

Resolution order: file → defaults. "Clear config" (menu command) deletes/resets
the file. A malformed file yields defaults (fault-tolerant load).

## 10. Cache

- Key: `sha256(imageBytes)` + prompt + provider/model + systemPrompt
  (`cacheKey`).
- Store: in-memory `Map`; optional disk JSON (LRU at `cacheMaxEntries`) when
  `cachePersist: true`.
- Only successes cached; never a fallback result under the primary key. Cache
  checked **before** any subagent spawn; a full hit = zero spawns. Local-only
  mode allows cache hits but refuses a miss before any spawn.

## 11. Validation items

Behaviors asserted from the API surface + confirmed at runtime where possible:

| Item | Status |
|---|---|
| `session.prompt` with `agent` + `model` override + `FilePartInput(dataURL)` delivers the image to the vision model | ⚠️ needs a live opencode restart + real delegation to confirm image visibility |
| Spawning a child session from inside a parent tool `execute` does not deadlock | ⚠️ strongly implied (`parentID` + child-session events), needs live confirmation |
| `chat.message` `output.parts` mutation (marker rewrite + `FilePart` push) reaches the LLM turn | ⚠️ needs live confirmation |
| `client.config.providers()` returns models with populated `capabilities` | ✅ type-verified; unit-testable via fake |
| `hidden: true` subagent is invokable by name via `session.prompt` | ⚠️ docs-confirmed ("hidden agents can still be invoked via the Task tool"), needs live confirmation |
| Plugin entries import cleanly with loader shape `{ id, server }` / `{ id, tui }` | ✅ verified (tsx import) |
| Delegate pipeline (cache/retry/fallback/abort/local-only) | ✅ unit-tested with a fake client |

Live smoke-test procedure (run after restarting opencode): see README
"Verification checklist".

## 12. Roadmap (post-v1)

- Client-side compression (`max-dim`/`quality` like pi-vision) using a pure-wasm
  image lib.
- Compose-time preview via TUI `ui.Prompt` refs / `slots`.
- `cache show|clear` status commands in the settings menu.
- Prompt normalization for cache-hit lift (pi-vision roadmap carry-over).
- Server-side fallback: if the TUI plugin fails to load, expose a minimal
  `/vision` config command via `config.command`.

## 13. Engineering principles (carried from the source project)

- Grow in layers: ship the smallest end-to-end version first.
- No speculative config/abstraction; add capabilities on top of a working
  product.
- Lean on opencode's own mechanisms (subagent, model registry, auth) before
  writing bespoke code — the whole point of this plugin is to reuse them.
