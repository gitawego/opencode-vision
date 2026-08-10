/**
 * Vision tool configuration — load/save `vision.json` in the opencode config
 * directory (`~/.config/opencode/vision.json`).
 *
 * Mirrors the pi `@gitawego/vision` config surface so the migration is zero
 * friction for users familiar with that tool. Stored in opencode's config dir
 * (not the pi agent dir) because this is an opencode plugin.
 *
 * Load is fault-tolerant: a missing or malformed file yields defaults so the
 * plugin always loads. Save is atomic (tmp + rename) so a crash mid-write
 * never leaves a truncated config.
 *
 * Pure + dependency-free (node:fs + node:path only) so both the server and
 * the TUI entries can share it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type MarkerStyle = "code" | "bold" | "plain";
export const MARKER_STYLES: readonly MarkerStyle[] = ["code", "bold", "plain"] as const;

export type PasteMode = "hint" | "auto" | "off";
export const PASTE_MODES: readonly PasteMode[] = ["hint", "auto", "off"] as const;

export const DEFAULT_AUTO_DELEGATE_PROMPT =
  "Describe this image concisely, focusing on visible content, text, diagrams, and layout.";

/** Hard cap on the number of images a single `describe_image` batch call can
 *  process. A safety bound, not a workflow knob. */
export const MAX_BATCH_IMAGES = 50;

/** Name of the hidden vision subagent registered by the server config hook. */
export const VISION_AGENT = "vision";

/** Name of the `describe_image` tool. */
export const TOOL_NAME = "describe_image";

export interface VisionConfig {
  /** Vision model provider id (e.g. "minimax"). Required for delegation. */
  provider: string | undefined;
  /** Vision model id under the provider (e.g. "MiniMax-M3"). Required for delegation. */
  model: string | undefined;
  /** Max image dimension (long edge) in pixels for compression. */
  maxDimension: number;
  /** JPEG re-encode quality (1–100) when compression is on. */
  jpegQuality: number;
  /** Master switch. When false, describe_image is hidden + errors if invoked. */
  enabled: boolean;
  /** Custom system prompt prepended to the vision-model request (undefined = none). */
  systemPrompt: string | undefined;
  /** When true, successful delegation results are cached (0 subagent spawns on hit). */
  cacheEnabled: boolean;
  /** When true, the cache also persists to disk (cross-session hits, LRU-evicted). */
  cachePersist: boolean;
  /** Max entries in the disk cache before LRU eviction. */
  cacheMaxEntries: number;
  /** Number of retries after the first failure (total attempts = retryAttempts + 1). */
  retryAttempts: number;
  /** Base backoff in ms for retry; delay = min(retryBackoffMs * 2^attempt, 8000). */
  retryBackoffMs: number;
  /** Fallback vision model provider (used when the primary exhausts retries / fails non-retryable). */
  fallbackProvider: string | undefined;
  /** Fallback vision model id under fallbackProvider. */
  fallbackModel: string | undefined;
  /** Markdown style for [Image-#N] markers: "code" (inline code), "bold", or "plain". */
  markerStyle: MarkerStyle;
  /** How pasted images are handled when the primary model is text-only:
   *  "hint" (default, zero-token nudge), "auto" (auto-delegate), "off" (markers only). */
  textOnlyPasteMode: PasteMode;
  /** Generic prompt for auto-delegation in text-only + "auto" mode. */
  autoDelegatePrompt: string;
  /** Timeout (ms) for auto-delegation in the paste hook (own AbortController). */
  autoDelegateTimeoutMs: number;
  /** When true, compose-time auto-preview shows images above the editor while typing (TUI). */
  composePreview: boolean;
  /** Max width (in terminal cells) for the preview rendering. */
  previewMaxWidthCells: number;
  /** Max number of image delegations to run in parallel (batch + paste auto). 1 = serial, 20 = aggressive. */
  batchConcurrency: number;
  /** When true, every delegation is appended to a JSONL audit log (routing only — never image bytes). */
  auditLog: boolean;
  /** Custom audit log path. When undefined → <configDir>/vision-audit.log. */
  auditLogPath: string | undefined;
  /** When true, image bytes never leave the machine. Cache hits still work; a miss refuses. */
  localOnly: boolean;
  /** When true + provider+model both unset, auto-detect the vision model at startup. */
  autoDetectVisionModel: boolean;
}

export const DEFAULT_CONFIG: VisionConfig = {
  provider: undefined,
  model: undefined,
  maxDimension: 1568,
  jpegQuality: 85,
  enabled: true,
  systemPrompt: undefined,
  cacheEnabled: true,
  cachePersist: false,
  cacheMaxEntries: 256,
  retryAttempts: 2,
  retryBackoffMs: 500,
  fallbackProvider: undefined,
  fallbackModel: undefined,
  markerStyle: "code",
  textOnlyPasteMode: "hint",
  autoDelegatePrompt: DEFAULT_AUTO_DELEGATE_PROMPT,
  autoDelegateTimeoutMs: 30000,
  composePreview: true,
  previewMaxWidthCells: 80,
  batchConcurrency: 5,
  auditLog: true,
  auditLogPath: undefined,
  localOnly: false,
  autoDetectVisionModel: true,
};

export const CONFIG_FILENAME = "vision.json";
export const AUDIT_FILENAME = "vision-audit.log";

/** Resolve the opencode config directory (fallible: env → XDG → home). */
export function opencodeConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0) {
    return join(resolve(process.env.XDG_CONFIG_HOME), "opencode");
  }
  return join(homedir(), ".config", "opencode");
}

/** Resolve the vision config path.
 *
 * - `OPENCODE_VISION_CONFIG` overrides everything (dev convenience).
 * - The TUI passes `api.state.path.config` (opencode's authoritative config
 *   dir) so the file lands exactly where the running opencode expects it.
 * - The server falls back to the standard opencode config dir resolution
 *   (XDG_CONFIG_HOME → ~/.config/opencode), which matches the TUI's path.
 */
export function visionConfigPath(preferredConfigDir?: string): string {
  const override = process.env.OPENCODE_VISION_CONFIG;
  if (override && override.trim().length > 0) return resolve(override.trim());
  if (preferredConfigDir && preferredConfigDir.trim().length > 0) return join(resolve(preferredConfigDir.trim()), CONFIG_FILENAME);
  return join(opencodeConfigDir(), CONFIG_FILENAME);
}

export function auditPath(config: VisionConfig, configDir?: string): string {
  if (config.auditLogPath && config.auditLogPath.trim().length > 0) return resolve(config.auditLogPath.trim());
  if (configDir && configDir.trim().length > 0) return join(resolve(configDir.trim()), AUDIT_FILENAME);
  return join(opencodeConfigDir(), AUDIT_FILENAME);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function strOrUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isMarkerStyle(value: unknown): value is MarkerStyle {
  return typeof value === "string" && (MARKER_STYLES as readonly string[]).includes(value);
}

function isPasteMode(value: unknown): value is PasteMode {
  return typeof value === "string" && (PASTE_MODES as readonly string[]).includes(value);
}

/** Merge a parsed partial config over the defaults, validating + clamping
 *  every field so a malformed file can never produce an invalid VisionConfig. */
export function mergeConfig(partial: unknown): VisionConfig {
  const p = (partial ?? {}) as Partial<Record<string, unknown>>;
  return {
    provider: strOrUndef(p.provider),
    model: strOrUndef(p.model),
    maxDimension: clampInt(p.maxDimension, 1, 8000, DEFAULT_CONFIG.maxDimension),
    jpegQuality: clampInt(p.jpegQuality, 1, 100, DEFAULT_CONFIG.jpegQuality),
    enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_CONFIG.enabled,
    systemPrompt: strOrUndef(p.systemPrompt),
    cacheEnabled: typeof p.cacheEnabled === "boolean" ? p.cacheEnabled : DEFAULT_CONFIG.cacheEnabled,
    cachePersist: typeof p.cachePersist === "boolean" ? p.cachePersist : DEFAULT_CONFIG.cachePersist,
    cacheMaxEntries: clampInt(p.cacheMaxEntries, 1, 10000, DEFAULT_CONFIG.cacheMaxEntries),
    retryAttempts: clampInt(p.retryAttempts, 0, 10, DEFAULT_CONFIG.retryAttempts),
    retryBackoffMs: clampInt(p.retryBackoffMs, 0, 60000, DEFAULT_CONFIG.retryBackoffMs),
    fallbackProvider: strOrUndef(p.fallbackProvider),
    fallbackModel: strOrUndef(p.fallbackModel),
    markerStyle: isMarkerStyle(p.markerStyle) ? p.markerStyle : DEFAULT_CONFIG.markerStyle,
    textOnlyPasteMode: isPasteMode(p.textOnlyPasteMode) ? p.textOnlyPasteMode : DEFAULT_CONFIG.textOnlyPasteMode,
    autoDelegatePrompt: strOrUndef(p.autoDelegatePrompt) ?? DEFAULT_CONFIG.autoDelegatePrompt,
    autoDelegateTimeoutMs: clampInt(p.autoDelegateTimeoutMs, 1000, 120000, DEFAULT_CONFIG.autoDelegateTimeoutMs),
    composePreview: typeof p.composePreview === "boolean" ? p.composePreview : DEFAULT_CONFIG.composePreview,
    previewMaxWidthCells: clampInt(p.previewMaxWidthCells, 20, 200, DEFAULT_CONFIG.previewMaxWidthCells),
    batchConcurrency: clampInt(p.batchConcurrency, 1, 20, DEFAULT_CONFIG.batchConcurrency),
    auditLog: typeof p.auditLog === "boolean" ? p.auditLog : DEFAULT_CONFIG.auditLog,
    auditLogPath: strOrUndef(p.auditLogPath),
    localOnly: typeof p.localOnly === "boolean" ? p.localOnly : DEFAULT_CONFIG.localOnly,
    autoDetectVisionModel: typeof p.autoDetectVisionModel === "boolean" ? p.autoDetectVisionModel : DEFAULT_CONFIG.autoDetectVisionModel,
  };
}

/** Load config from the opencode config dir. Returns defaults on any read/parse error. */
export function loadConfig(path = visionConfigPath()): VisionConfig {
  try {
    const raw = readFileSync(path, "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Atomically write config (tmp file + rename). */
export function saveConfig(config: VisionConfig, path = visionConfigPath()): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Whether the config has the minimum required fields for delegation. */
export function isConfiguredForDelegation(config: VisionConfig): boolean {
  return !!config.provider && !!config.model;
}
