/**
 * Image helpers — pure + dependency-free.
 *
 * v1 does NOT do client-side compression (no native image library in the
 * plugin runtime); images are attached as-is via data URLs and the vision
 * provider downscales server-side. `maxDimension`/`jpegQuality` are kept in
 * the config surface for parity and future use.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";

/** MIME types we accept + attach. GIFs are detected but attachment of
 *  multi-frame GIFs is provider-dependent; harmless to pass through. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

/** Whether a path looks like an image by extension. */
export function hasImageExtension(path: string): boolean {
  return IMAGE_EXT_RE.test(path);
}

/** Sniff the mime from the first bytes; falls back to the extension map. */
export function detectMime(path: string, data: Uint8Array): string | undefined {
  // Magic bytes
  if (data.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
    // JPEG: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    // GIF: "GIF8"
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
    // WebP: "RIFF" .... "WEBP"
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) return "image/webp";
    // BMP: "BM"
    if (data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
    // AVIF: "ftypavif" / "ftypavis" at offset 4
    if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return "image/avif";
  }
  // SVG: text, starts with "<svg" or "<?xml" (allow leading whitespace/BOM)
  if (data.length > 4) {
    const head = Buffer.from(data.subarray(0, 512)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  }
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

/** A loaded image: raw bytes + resolved metadata. */
export interface LoadedImage {
  /** Absolute path the image was loaded from. */
  abs: string;
  data: Uint8Array;
  mimeType: string;
  /** SHA-256 hex of the original bytes (content fingerprint / cache key seed). */
  sourceHash: string;
}

export type LoadImageResult =
  | { ok: true; image: LoadedImage }
  | { ok: false; errorCode: "not_found" | "not_a_file" | "unsupported_format" | "read_error"; message: string };

/** Resolve a path token against a base directory (unescaping `\ ` from
 *  terminal drag-and-drop), verify it exists and is a file, and load its
 *  bytes. Returns a structured error on failure. */
export function loadImage(token: string, baseDir: string): LoadImageResult {
  const unescaped = token.replace(/\\ /g, " ");
  const expanded = unescaped.startsWith("~/") ? resolvePath(baseDir, unescaped) : unescaped;
  const abs = isAbsolute(expanded) ? expanded : resolvePath(baseDir, expanded);

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, errorCode: "not_found", message: `image not found at "${token}"` };
  }
  if (!stat.isFile()) {
    return { ok: false, errorCode: "not_a_file", message: `"${token}" is not a file` };
  }

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    return { ok: false, errorCode: "read_error", message: err instanceof Error ? err.message : String(err) };
  }
  const mimeType = detectMime(abs, buf);
  if (!mimeType) {
    return { ok: false, errorCode: "unsupported_format", message: `could not determine the image format of "${token}"` };
  }
  return {
    ok: true,
    image: { abs, data: buf, mimeType, sourceHash: sha256(buf) },
  };
}

/** SHA-256 hex digest of a byte array. */
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Encode raw bytes as a data URL for attachment/delegation. */
export function toDataURL(data: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}
