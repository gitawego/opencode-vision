/**
 * Audit log (ported from `@gitawego/vision` lib/audit.ts). Every delegation
 * (success, cache hit, fallback, failure, local-only refusal) is appended as
 * one JSONL line. Records *routing* (where bytes went), never content — image
 * bytes are only fingerprinted via `source_hash`, and the prompt is never
 * logged.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface AuditEntry {
  ts: string;
  provider: string;
  model: string;
  image_path: string;
  source_hash: string;
  cached: boolean;
  fallback: boolean;
  fallback_model: string | undefined;
  ok: boolean;
  error_code: string | undefined;
  latency_ms: number;
  local_only: boolean;
}

/** Truncate a data: URL / base64 image_path to its first 64 chars + size suffix. */
export function truncateImagePathForLog(path: string): string {
  if (path.length <= 100) return path;
  if (path.startsWith("data:") || path.length > 160) return `${path.slice(0, 64)}…(+${path.length - 64} chars)`;
  return path.slice(0, 100);
}

export function appendAuditEntry(path: string, entry: AuditEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // best-effort audit
  }
}

export function tailAuditLog(path: string, n: number): AuditEntry[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l) as AuditEntry;
      } catch {
        return null;
      }
    }).filter((e): e is AuditEntry => e !== null);
  } catch {
    return [];
  }
}

export function countAuditLog(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

export function clearAuditLog(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
  } catch {
    // best-effort
  }
}
