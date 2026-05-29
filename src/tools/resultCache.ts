import { randomUUID } from "node:crypto";

export const MAX_LSP_RESULT_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_LSP_RESULT_CACHE_ENTRIES = 128;
export const LSP_RESULT_CACHE_TTL_MS = 15 * 60 * 1000;
export const LSP_RESULT_ID_PREFIX = "lspres_";
export const LSP_RESULT_ID_LENGTH = LSP_RESULT_ID_PREFIX.length + 36;
export const LSP_RESULT_ID_PATTERN = `^${LSP_RESULT_ID_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;

const LSP_RESULT_ID_REGEX = new RegExp(LSP_RESULT_ID_PATTERN, "u");

export interface LspCachedPage {
  text: string;
  details: unknown;
}

export interface StoreLspResultInput {
  label: string;
  pages: LspCachedPage[];
}

export interface LspResultCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface LspResultCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
}

interface CacheEntry {
  id: string;
  label: string;
  pages: LspCachedPage[];
  nextPageIndex: number;
  bytes: number;
  createdAt: number;
  accessedAt: number;
}

export class LspResultCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(options: LspResultCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_LSP_RESULT_CACHE_BYTES;
    this.maxEntries = options.maxEntries ?? MAX_LSP_RESULT_CACHE_ENTRIES;
    this.ttlMs = options.ttlMs ?? LSP_RESULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  store(input: StoreLspResultInput): string | undefined {
    this.evictExpired();
    if (input.pages.length <= 1) return undefined;

    const timestamp = this.now();
    const entry: CacheEntry = {
      id: `${LSP_RESULT_ID_PREFIX}${randomUUID()}`,
      label: input.label,
      pages: input.pages,
      nextPageIndex: 1,
      bytes: estimateBytes(input),
      createdAt: timestamp,
      accessedAt: timestamp,
    };

    if (entry.bytes > this.maxBytes) return undefined;

    this.entries.set(entry.id, entry);
    this.bytes += entry.bytes;
    this.evictToBudget();
    return this.entries.has(entry.id) ? entry.id : undefined;
  }

  next(resultId: string): { content: [{ type: "text"; text: string }]; details: unknown } {
    if (!isLspResultId(resultId)) {
      return toolResult("Invalid LSP resultId format. Use the exact resultId from a previous paginated LSP result.", {
        ok: false,
        error: "invalid-result-id",
      });
    }

    this.evictExpired();
    const entry = this.entries.get(resultId);
    if (!entry) {
      return toolResult(
        "Cached LSP result not found or expired. Re-run the original LSP query to get a fresh resultId.",
        {
          ok: false,
          resultId,
          error: "not-found",
        },
      );
    }

    entry.accessedAt = this.now();
    const page = entry.pages[entry.nextPageIndex];
    if (!page) {
      this.delete(resultId);
      return toolResult(`No more cached LSP pages for ${resultId}.`, {
        ok: true,
        resultId,
        done: true,
      });
    }

    entry.nextPageIndex += 1;
    return toolResult(page.text, page.details);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): LspResultCacheStats {
    this.evictExpired();
    return { entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.accessedAt < cutoff) this.delete(id);
    }
  }

  private evictToBudget(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = [...this.entries.values()].sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (!oldest) return;
      this.delete(oldest.id);
    }
  }

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
  }
}

export function isLspResultId(value: string): boolean {
  return value.length === LSP_RESULT_ID_LENGTH && LSP_RESULT_ID_REGEX.test(value);
}

function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function toolResult(text: string, details: unknown): { content: [{ type: "text"; text: string }]; details: unknown } {
  return { content: [{ type: "text", text }], details };
}
