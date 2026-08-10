/**
 * Content-addressed delegation cache (ported from `@gitawego/vision`
 * lib/cache.ts). Successful delegation results are cached by a key derived
 * from the original image bytes hash + prompt + model + system prompt, so a
 * second call on the same image + prompt costs zero subagent spawns.
 *
 * Memory-only by default; when `persistPath` is provided the cache also
 * persists to a JSON file (LRU-evicted at maxEntries).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CacheEntry {
  text: string;
  model: string;
  storedAt: number;
}

interface DiskShape {
  entries: Record<string, CacheEntry>;
}

/**
 * Build a stable content-addressed cache key. Mirrors the pi-vision key
 * shape (image hash + compression params + prompt + model + system prompt)
 * minus the reasoning field (opencode delegation doesn't expose it).
 */
export function cacheKey(
  sourceHash: string,
  compress: boolean,
  maxDimension: number,
  jpegQuality: number,
  prompt: string,
  modelId: string,
  systemPrompt: string | undefined,
): string {
  return [sourceHash, compress ? `${maxDimension}:${jpegQuality}` : "raw", prompt, modelId, systemPrompt ?? ""].join("|");
}

export class VisionCache {
  private memory = new Map<string, CacheEntry>();
  private persistPath: string | undefined;
  private maxEntries: number;

  constructor(persistPath: string | undefined, maxEntries: number) {
    this.persistPath = persistPath;
    this.maxEntries = Math.max(1, maxEntries);
    if (persistPath && existsSync(persistPath)) {
      try {
        const disk = JSON.parse(readFileSync(persistPath, "utf8")) as DiskShape;
        if (disk && typeof disk === "object" && disk.entries) {
          for (const [key, entry] of Object.entries(disk.entries)) {
            if (entry && typeof entry.text === "string") this.memory.set(key, entry);
          }
        }
      } catch {
        // corrupt disk cache → start fresh
      }
    }
  }

  get(key: string): CacheEntry | undefined {
    const hit = this.memory.get(key);
    if (hit) {
      // LRU touch: move to end
      this.memory.delete(key);
      this.memory.set(key, hit);
    }
    return hit;
  }

  set(key: string, entry: CacheEntry): void {
    this.memory.delete(key); // re-insert to keep insertion-order LRU
    this.memory.set(key, entry);
    // Evict oldest beyond max
    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
    if (this.persistPath) this.persist();
  }

  clear(): void {
    this.memory.clear();
    if (this.persistPath) this.persist();
  }

  stats(): { entries: number; maxEntries: number; persisted: boolean } {
    return { entries: this.memory.size, maxEntries: this.maxEntries, persisted: !!this.persistPath };
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      const shape: DiskShape = { entries: Object.fromEntries(this.memory.entries()) };
      writeFileSync(tmp, JSON.stringify(shape), "utf8");
      renameSync(tmp, this.persistPath);
    } catch {
      // best-effort persistence
    }
  }
}
