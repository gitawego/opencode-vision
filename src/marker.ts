/**
 * Marker rendering for the paste UX — pure functions (ported from
 * `@gitawego/pi-vision` lib/marker.ts).
 *
 * Rewrites image file-path tokens into `[Image-#N]` markers, and builds the
 * hint line (text-only + "hint" mode), the descriptions block (text-only +
 * "auto" mode), and the structured batch tool result.
 *
 * No I/O — fully unit-testable.
 */
import type { MarkerStyle } from "./config";

/** Wrap a `[Image-#N]` marker in the configured markdown style. */
export function styleMarker(index: number, style: MarkerStyle): string {
  const base = `[Image-#${index}]`;
  switch (style) {
    case "code":
      return `\`${base}\``;
    case "bold":
      return `**${base}**`;
    case "plain":
    default:
      return base;
  }
}

/**
 * Render `[Image-#N]` markers into text, replacing resolved path tokens.
 * `resolved` maps each loaded token to its 0-based index in the final images
 * array. Markers are 1-indexed (index 0 → `[Image-#1]`). Unresolvable tokens
 * are left as-is. Replacement is done right-to-left so earlier indices don't
 * shift; for overlapping tokens the longest match at each position wins.
 */
export function renderMarkers(
  text: string,
  tokens: string[],
  resolved: Map<string, { index: number }>,
  style: MarkerStyle,
): string {
  type Replacement = { start: number; end: number; marker: string };
  const replacements: Replacement[] = [];

  for (const token of tokens) {
    const info = resolved.get(token);
    if (!info) continue;
    const marker = styleMarker(info.index + 1, style);
    let searchFrom = 0;
    while (searchFrom <= text.length) {
      const pos = text.indexOf(token, searchFrom);
      if (pos === -1) break;
      replacements.push({ start: pos, end: pos + token.length, marker });
      searchFrom = pos + token.length;
    }
  }

  if (replacements.length === 0) return text;

  // Longest match wins at each position: keep the longest replacement per
  // start offset, then accept non-overlapping runs left-to-right.
  const byStart = new Map<number, Replacement>();
  for (const r of replacements) {
    const cur = byStart.get(r.start);
    if (!cur || r.end > cur.end) byStart.set(r.start, r);
  }
  const uniq = [...byStart.values()].sort((a, b) => a.start - b.start);
  const accepted: Replacement[] = [];
  let lastEnd = -1;
  for (const r of uniq) {
    if (r.start >= lastEnd) {
      accepted.push(r);
      lastEnd = r.end;
    }
  }

  // Apply replacements right-to-left (indices stay stable).
  let result = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const r = accepted[i]!;
    result = result.slice(0, r.start) + r.marker + result.slice(r.end);
  }
  return result;
}

/** Build the hint line appended in text-only + "hint" mode. Lists the image
 *  paths (indented) so the model can actually call `describe_image`; for N≥2
 *  it names the `image_paths` batch affordance. */
export function buildHintLine(
  images: Array<{ token: string; index: number }>,
): string {
  const n = images.length;
  if (n === 0) return "0 images referenced.";
  const noun = n === 1 ? "image" : "images";
  const verb = n === 1 ? "analyze it" : "analyze them";
  const clause = n >= 2 ? " (single, or pass all paths to image_paths for batch analysis)" : "";
  const pathLines = images.map((img) => `  ${img.token}`).join("\n");
  return `${n} ${noun} referenced. The active model cannot process images natively — use the describe_image tool to ${verb}${clause}.
Image paths:
${pathLines}`;
}

/** A per-image result for the batch tool-result builder. */
export type BatchImageResult =
  | { ok: true; text: string; cached: boolean; fallback: boolean; fallbackModel?: string }
  | { ok: false; errorCode: string; message: string };

/** Build the structured per-image tool-result text for a batch
 *  `describe_image` call. `results` must be in input order (matching `paths`). */
export function buildBatchToolResult(
  paths: string[],
  results: BatchImageResult[],
): string {
  if (paths.length === 0) return "[Batch: 0 image(s)]";
  const lines: string[] = [`[Batch: ${paths.length} image(s)]`, ""];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const r = results[i];
    const header = `[Image ${i + 1}]`;
    if (r && r.ok) {
      const tags: string[] = [];
      if (r.cached) tags.push("cached");
      if (r.fallback) tags.push(`fallback: ${r.fallbackModel ?? "unknown"}`);
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      lines.push(`${header}${tagStr} ${path}`);
      lines.push(r.text);
      lines.push("");
    } else if (r && !r.ok) {
      lines.push(`${header} ${path}`);
      lines.push(`[error: ${r.errorCode} — ${r.message}]`);
      lines.push("");
    } else {
      lines.push(`${header} ${path}`);
      lines.push("[error: unexpected — no result for this image]");
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

/** Build the descriptions block appended in text-only + "auto" mode. */
export function buildDescriptionsBlock(
  descriptions: Array<{ token: string; index: number; text: string; cached: boolean }>,
  visionModel: string,
): string {
  if (descriptions.length === 0) return "";
  const lines = descriptions.map((d) => {
    const label = styleMarker(d.index + 1, "code");
    const cachedTag = d.cached ? " (cached)" : "";
    return `[${label} ${d.token}]: ${d.text}${cachedTag}`;
  });
  const footer = `[${descriptions.length} image(s) auto-described via ${visionModel}. Set textOnlyPasteMode to "hint" to delegate on-demand instead.]`;
  return `\n\n${lines.join("\n")}\n${footer}`;
}
