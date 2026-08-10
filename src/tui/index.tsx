/* @jsxImportSource @opentui/solid */
/**
 * opencode-vision — TUI plugin entry.
 *
 * Provides the interactive settings menu (the pi-vision `/vision` panel
 * equivalent):
 *
 * - `/vision` slash command + command-palette entry → the settings menu
 *   (a host-driven DialogSelect cascade — keyboard nav, filtering and
 *   Escape/back handling are provided by the host).
 * - `ctrl+shift+i` hotkey → quick vision-model picker (pi-vision parity).
 * - `Vision: show status`, `Vision: clear config` commands.
 *
 * Config is written to the same `vision.json` the server reads
 * (`<opencode config dir>/vision.json`, resolved via `api.state.path.config`).
 *
 * Module shape (required by the opencode loader):
 *   export default { id, tui }
 *
 * The server-side hooks/tool live in the sibling package entry `./server`.
 * A single file must NOT export both server and tui.
 */
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { join } from "node:path";
import type { JSX } from "solid-js";
import {
  DEFAULT_CONFIG,
  loadConfig,
  MARKER_STYLES,
  PASTE_MODES,
  saveConfig,
  visionConfigPath,
  type MarkerStyle,
  type PasteMode,
  type VisionConfig,
} from "../config";

function configPath(api: TuiPluginApi): string {
  const dir = api.state.path.config;
  return dir && dir.trim().length > 0 ? join(dir, "vision.json") : visionConfigPath();
}

function readConfig(api: TuiPluginApi): VisionConfig {
  return loadConfig(configPath(api));
}

function writeConfig(api: TuiPluginApi, config: VisionConfig): void {
  try {
    saveConfig(config, configPath(api));
  } catch {
    // surface via toast
  }
}

/** Enumerate vision-capable models from the resolved provider list. */
function visionModels(api: TuiPluginApi): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const provider of api.state.provider ?? []) {
    for (const model of Object.values(provider.models ?? {})) {
      if (model.capabilities?.input?.image) {
        out.push({ id: `${provider.id}/${model.id}`, label: `${provider.id}/${model.id}` });
      }
    }
  }
  return out;
}

/** Apply a config patch + persist + toast. */
function apply(api: TuiPluginApi, patch: Partial<VisionConfig>): void {
  const next = { ...readConfig(api), ...patch };
  writeConfig(api, next);
  api.ui.toast({ variant: "success", title: "Vision", message: "Settings saved." });
}

/** Re-open the main menu after a sub-selection (host-driven navigation). */
function reopen(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => mainMenu(api), () => {});
}

function option(title: string, value: string, description?: string): TuiDialogSelectOption {
  return { title, value, description };
}

/** Simple toggle sub-select. */
function toggleSelect(api: TuiPluginApi, label: string, current: boolean, set: (on: boolean) => Partial<VisionConfig>): JSX.Element {
  const currentValue = current ? "on" : "off";
  return (
    <api.ui.DialogSelect
      title={label}
      placeholder="Type to filter"
      current={currentValue}
      options={[
        option("on", "on", currentValue === "on" ? "current" : undefined),
        option("off", "off", currentValue === "off" ? "current" : undefined),
      ]}
      onSelect={(opt) => {
        if (!opt) return;
        apply(api, set(opt.value === "on"));
        reopen(api);
      }}
    />
  );
}

/** Enum sub-select (paste mode / marker style / cache max / concurrency / …). */
function enumSelect<T extends string>(
  api: TuiPluginApi,
  label: string,
  values: readonly T[],
  current: T,
  applyPatch: (v: T) => Partial<VisionConfig>,
): JSX.Element {
  return (
    <api.ui.DialogSelect
      title={label}
      placeholder="Type to filter"
      current={current}
      options={values.map((v) => option(v, v, v === current ? "current" : undefined))}
      onSelect={(opt) => {
        if (!opt) return;
        apply(api, applyPatch(opt.value as T));
        reopen(api);
      }}
    />
  );
}

/** The vision-model picker (DialogSelect over vision-capable models). */
function modelPicker(api: TuiPluginApi): JSX.Element {
  const models = visionModels(api);
  const cfg = readConfig(api);
  const current = cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : undefined;
  const opts: TuiDialogSelectOption[] =
    models.length > 0
      ? models.map((m) => option(m.label, m.id, m.id === current ? "current" : undefined))
      : [{ title: "(no vision-capable models configured)", value: "" }];

  return (
    <api.ui.DialogSelect
      title="Vision model"
      placeholder="Type to filter"
      current={current}
      options={opts}
      onSelect={(opt) => {
        if (!opt || !opt.value) return;
        const value = String(opt.value);
        const slash = value.indexOf("/");
        if (slash <= 0 || slash >= value.length - 1) return;
        apply(api, { provider: value.slice(0, slash), model: value.slice(slash + 1) });
        reopen(api);
      }}
    />
  );
}

/** The main settings menu. */
function mainMenu(api: TuiPluginApi): JSX.Element {
  const cfg = readConfig(api);
  const modelLabel = cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : "(auto-detect / not set)";

  return (
    <api.ui.DialogSelect
      title="Vision settings"
      placeholder="Type to filter"
      options={[
        {
          title: `Vision model: ${modelLabel}`,
          value: "model",
          description: "Model to delegate image analysis to (must support image input)",
        },
        {
          title: `Paste mode: ${cfg.textOnlyPasteMode}`,
          value: "textOnlyPasteMode",
          description: "How pasted images are handled on a text-only primary: hint (nudge), auto (auto-delegate), off",
        },
        {
          title: `Marker style: ${cfg.markerStyle}`,
          value: "markerStyle",
          description: "Markdown style for [Image-#N] markers",
        },
        {
          title: `Local-only: ${cfg.localOnly ? "on" : "off"}`,
          value: "localOnly",
          description: "When on, image bytes never leave the machine (cache hits still work)",
        },
        {
          title: `Cache persist: ${cfg.cachePersist ? "on" : "off"}`,
          value: "cachePersist",
          description: "Persist the delegation cache to disk (cross-session hits)",
        },
        {
          title: `Cache max entries: ${cfg.cacheMaxEntries}`,
          value: "cacheMaxEntries",
          description: "Disk-cache size before LRU eviction",
        },
        {
          title: `Auto-delegate timeout: ${Math.round(cfg.autoDelegateTimeoutMs / 1000)}s`,
          value: "autoDelegateTimeoutMs",
          description: "Timeout for auto-delegation in the paste hook",
        },
        {
          title: `Batch concurrency: ${cfg.batchConcurrency}`,
          value: "batchConcurrency",
          description: "Max parallel image delegations (1 = serial, 20 = aggressive)",
        },
        {
          title: `Max dimension: ${cfg.maxDimension}px`,
          value: "maxDimension",
          description: "Max long-edge pixels (reserved; compression not yet implemented)",
        },
        {
          title: `JPEG quality: ${cfg.jpegQuality}`,
          value: "jpegQuality",
          description: "Re-encode quality (reserved; compression not yet implemented)",
        },
        {
          title: `Auto-detect vision model: ${cfg.autoDetectVisionModel ? "on" : "off"}`,
          value: "autoDetectVisionModel",
          description: "Auto-pick a vision-capable model when none is configured",
        },
        {
          title: `Audit log: ${cfg.auditLog ? "on" : "off"}`,
          value: "auditLog",
          description: "Record delegation routing (never image bytes) to vision-audit.log",
        },
        { title: "Show status", value: "show", description: "Print the current configuration" },
        { title: "Clear config", value: "clear", description: "Reset all settings to defaults" },
        { title: "Done", value: "done", description: "Close the settings panel" },
      ]}
      onSelect={(opt) => {
        if (!opt) return;
        switch (opt.value) {
          case "model":
            api.ui.dialog.replace(() => modelPicker(api), () => {});
            break;
          case "textOnlyPasteMode":
            api.ui.dialog.replace(() => enumSelect(api, "Paste mode", PASTE_MODES, cfg.textOnlyPasteMode, (v) => ({ textOnlyPasteMode: v as PasteMode })), () => {});
            break;
          case "markerStyle":
            api.ui.dialog.replace(() => enumSelect(api, "Marker style", MARKER_STYLES, cfg.markerStyle, (v) => ({ markerStyle: v as MarkerStyle })), () => {});
            break;
          case "localOnly":
            api.ui.dialog.replace(() => toggleSelect(api, "Local-only", cfg.localOnly, (on) => ({ localOnly: on })), () => {});
            break;
          case "cachePersist":
            api.ui.dialog.replace(() => toggleSelect(api, "Cache persist", cfg.cachePersist, (on) => ({ cachePersist: on })), () => {});
            break;
          case "cacheMaxEntries":
            api.ui.dialog.replace(() => enumSelect(api, "Cache max entries", ["64", "128", "256", "512", "1024"] as const, String(cfg.cacheMaxEntries), (v) => ({ cacheMaxEntries: parseInt(v, 10) })), () => {});
            break;
          case "autoDelegateTimeoutMs":
            api.ui.dialog.replace(() => enumSelect(api, "Auto-delegate timeout", ["10000", "20000", "30000", "60000"] as const, String(cfg.autoDelegateTimeoutMs), (v) => ({ autoDelegateTimeoutMs: parseInt(v, 10) })), () => {});
            break;
          case "batchConcurrency":
            api.ui.dialog.replace(() => enumSelect(api, "Batch concurrency", ["1", "3", "5", "10", "20"] as const, String(cfg.batchConcurrency), (v) => ({ batchConcurrency: parseInt(v, 10) })), () => {});
            break;
          case "maxDimension":
            api.ui.dialog.replace(() => enumSelect(api, "Max dimension", ["512", "1024", "1568", "2048", "4096"] as const, String(cfg.maxDimension), (v) => ({ maxDimension: parseInt(v, 10) })), () => {});
            break;
          case "jpegQuality":
            api.ui.dialog.replace(() => enumSelect(api, "JPEG quality", ["70", "80", "85", "90", "95"] as const, String(cfg.jpegQuality), (v) => ({ jpegQuality: parseInt(v, 10) })), () => {});
            break;
          case "autoDetectVisionModel":
            api.ui.dialog.replace(() => toggleSelect(api, "Auto-detect vision model", cfg.autoDetectVisionModel, (on) => ({ autoDetectVisionModel: on })), () => {});
            break;
          case "auditLog":
            api.ui.dialog.replace(() => toggleSelect(api, "Audit log", cfg.auditLog, (on) => ({ auditLog: on })), () => {});
            break;
          case "show":
            api.ui.toast({ variant: "info", title: "Vision config", message: formatStatus(cfg) });
            break;
          case "clear":
            writeConfig(api, { ...DEFAULT_CONFIG });
            api.ui.toast({ variant: "success", title: "Vision", message: "Config reset to defaults." });
            reopen(api);
            break;
          case "done":
          default:
            api.ui.dialog.clear();
            break;
        }
      }}
    />
  );
}

/** Multi-line status text (mirrors pi's /vision show). */
function formatStatus(c: VisionConfig): string {
  return [
    `enabled:           ${c.enabled}`,
    `model:             ${c.provider && c.model ? `${c.provider}/${c.model}` : "(not set / auto-detect)"}`,
    `maxDimension:      ${c.maxDimension}px`,
    `jpegQuality:       ${c.jpegQuality}`,
    `systemPrompt:      ${c.systemPrompt ? c.systemPrompt.slice(0, 40) + (c.systemPrompt.length > 40 ? "…" : "") : "(none)"}`,
    `cache:             ${c.cacheEnabled ? "on" : "off"}${c.cachePersist ? ` (persisted, max ${c.cacheMaxEntries})` : ""}`,
    `retry:             ${c.retryAttempts} attempts, ${c.retryBackoffMs}ms backoff`,
    `fallback:          ${c.fallbackProvider && c.fallbackModel ? `${c.fallbackProvider}/${c.fallbackModel}` : "(none)"}`,
    `markerStyle:       ${c.markerStyle}`,
    `textOnlyPaste:     ${c.textOnlyPasteMode}`,
    `autoTimeout:       ${c.autoDelegateTimeoutMs}ms`,
    `batchConcurrency:  ${c.batchConcurrency}`,
    `localOnly:         ${c.localOnly ? "on" : "off"}`,
    `auditLog:          ${c.auditLog ? "on" : "off"}`,
    `autoDetect:        ${c.autoDetectVisionModel ? "on" : "off"}`,
  ].join("\n");
}

export const VisionTuiPlugin: TuiPlugin = async (api, _options, _meta) => {
  const openMenu = () => {
    if (!api.ui.dialog.open) api.ui.dialog.replace(() => mainMenu(api), () => {});
  };
  const openModelPicker = () => {
    if (!api.ui.dialog.open) api.ui.dialog.replace(() => modelPicker(api), () => {});
  };

  const disposers: Array<() => void> = [];

  // ── Legacy command API (slash command + command palette + keybinds) ─────
  if (api.command) {
    const unsub = api.command.register(() => [
      {
        title: "Vision settings",
        value: "vision.settings",
        description: "Open the vision plugin settings panel",
        category: "Vision",
        keybind: "ctrl+shift+m",
        slash: { name: "vision" },
        onSelect: () => openMenu(),
      },
      {
        title: "Vision: pick model",
        value: "vision.model",
        description: "Pick the vision model to delegate to",
        category: "Vision",
        keybind: "ctrl+shift+i",
        onSelect: () => openModelPicker(),
      },
      {
        title: "Vision: show status",
        value: "vision.show",
        description: "Show the current vision plugin configuration",
        category: "Vision",
        onSelect: () => {
          api.ui.toast({ variant: "info", title: "Vision config", message: formatStatus(readConfig(api)) });
        },
      },
      {
        title: "Vision: clear config",
        value: "vision.clear",
        description: "Reset the vision plugin configuration to defaults",
        category: "Vision",
        onSelect: () => {
          writeConfig(api, { ...DEFAULT_CONFIG });
          api.ui.toast({ variant: "success", title: "Vision", message: "Config reset to defaults." });
        },
      },
    ]);
    disposers.push(unsub);
  }

  // ── Keymap fallback (if the legacy command API is absent) ───────────────
  try {
    const unsub = api.keymap.registerLayer({
      commands: [
        { name: "vision.open", run: () => openMenu(), title: "Vision settings", category: "Vision" },
        { name: "vision.model", run: () => openModelPicker(), title: "Vision: pick model", category: "Vision" },
      ],
      bindings: [
        { key: "ctrl+shift+m", cmd: "vision.open" },
        { key: "ctrl+shift+i", cmd: "vision.model" },
      ],
    });
    disposers.push(unsub);
  } catch {
    // keymap unavailable — the legacy command API covers the common case
  }

  api.lifecycle.onDispose(() => {
    for (const d of disposers) d();
  });
};

export default { id: "opencode-vision", tui: VisionTuiPlugin };
