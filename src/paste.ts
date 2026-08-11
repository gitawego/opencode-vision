/**
 * Paste/rewrite core (ported from `@gitawego/pi-vision` extensions/paste.ts +
 * lib/marker.ts). Detects image file-path tokens in free text and rewrites
 * them into `[Image-#N]` markers.
 *
 * Pure (no opencode runtime dependency) so it can be unit-tested and shared by
 * the server `chat.message` hook and the TUI compose preview.
 */
import { loadImage, toDataURL, type LoadedImage } from "./image";
import { renderMarkers, styleMarker } from "./marker";

// Matches path-like tokens ending in a known image extension:
//   POSIX absolute /…, home ~/…, relative ./…/…/ , bare relative with a
//   separator (images/shot.png), Windows drive paths C:\…, C:/…
//   Allows \ (escaped space) from terminal drag-and-drop. URLs (http://…)
//   can match the relative branch but are filtered later by the file check.
const PATH_TOKEN_RE =
  /(?:[A-Za-z]:[\\/]|\/|~\/|\.{1,2}\/|\S+\/)(?:\\ |[^\s)"'<>])+\.(?:png|jpe?g|gif|webp|bmp)/gi;

/**
 * Extract candidate image file-path tokens from free text. Bare filenames
 * without a path separator are deliberately not matched to avoid false
 * positives on ordinary words (pi-vision behavior).
 */
export function findImagePathTokens(text: string): string[] {
  const out: string[] = [];
  PATH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    out.push(m[0]);
  }
  return [...new Set(out)];
}

/** A detected, loaded image ready for attachment or delegation. */
export interface DetectedImage {
  /** The raw token as it appeared in the text. */
  token: string;
  /** Absolute path on disk. */
  abs: string;
  mimeType: string;
  /** Original bytes (content fingerprint / attachment source). */
  data: Uint8Array;
  /** SHA-256 hex of the original bytes. */
  sourceHash: string;
  /** Data URL for attachment/delegation. */
  dataURL: string;
  /** 0-based marker index within the message. */
  index: number;
}

/**
 * Resolve + load all tokens that exist on disk as image files. Returns the
 * loaded images (deduped by absolute path, preserving order) and the tokens
 * that could not be resolved. Unresolvable tokens are left as-is in the text.
 */
export function detectImages(
  tokens: string[],
  baseDir: string,
): { loaded: DetectedImage[]; unresolved: string[] } {
  const loaded: DetectedImage[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const result = loadImage(token, baseDir);
    if (!result.ok) {
      unresolved.push(token);
      continue;
    }
    const img: LoadedImage = result.image;
    if (seen.has(img.abs)) continue;
    seen.add(img.abs);
    loaded.push({
      token,
      abs: img.abs,
      mimeType: img.mimeType,
      data: img.data,
      sourceHash: img.sourceHash,
      dataURL: toDataURL(img.data, img.mimeType),
      index: loaded.length,
    });
  }
  return { loaded, unresolved };
}

/** Substitute markers for the loaded tokens. `offset` shifts marker indices
 *  when pre-existing attachments occupy indices 0..offset-1 (multimodal). */
export function rewriteWithMarkers(
  text: string,
  loaded: DetectedImage[],
  style: "code" | "bold" | "plain",
  offset = 0,
): string {
  const resolved = new Map<string, { index: number }>();
  for (const img of loaded) resolved.set(img.token, { index: offset + img.index });
  return renderMarkers(text, loaded.map((l) => l.token), resolved, style);
}

/** Render the marker label for a loaded image (used in hint/descriptions). */
export function markerFor(img: DetectedImage, style: "code" | "bold" | "plain"): string {
  return styleMarker(img.index + 1, style);
}
