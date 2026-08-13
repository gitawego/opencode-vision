/**
 * Host-agnostic tool-argument helpers shared by the v1 server adapter and the
 * v2 adapter (identical behavior in both hosts).
 */

/** Normalize image_path / image_paths (tolerating JSON-stringified arrays),
 *  dedup, cap, and resolve order (image_paths first, then image_path).
 *  Accepts readonly arrays (v2 schemas decode to readonly tuples). */
export function normalizeImagePaths(args: {
  image_path?: string | readonly string[];
  image_paths?: string | readonly string[];
}): string[] {
  const coerce = (v: string | readonly string[] | undefined): string[] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (typeof v !== "string") return [];
    const s = v.trim();
    if (s === "") return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
      } catch {
        // not valid JSON → treat as a single path string
      }
    }
    return [s];
  };
  const merged = [...coerce(args.image_paths), ...coerce(args.image_path)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of merged) {
    const t = p.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Build the tool result text for a (possibly batched) delegation. Since the
 *  vision subagent analyzes all images in one turn, a batch yields one combined
 *  description. */
export function buildToolOutput(
  paths: string[],
  loaded: { abs: string; index: number }[],
  text: string,
  cached: boolean,
): string {
  if (paths.length === 1) {
    return cached ? `(cached)\n\n${text}` : text;
  }
  const lines: string[] = [`[Batch: ${loaded.length} image(s)]`, ""];
  for (const img of loaded) {
    lines.push(`[Image ${img.index + 1}] ${img.abs}`);
  }
  lines.push("", text);
  return lines.join("\n");
}
