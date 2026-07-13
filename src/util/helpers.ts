import { access } from "node:fs/promises";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function normalizeProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
      // On Windows, process.env is case-insensitive but a plain copied object is
      // not: Windows stores PATH as "Path", so downstream reads of env.PATH would
      // be undefined. Mirror only PATH/PATHEXT to upper-case keys — uppercasing
      // every key could break case-sensitive variables spawned tools expect
      // (GOBIN, GOPATH, ...).
      if (process.platform === "win32") {
        const upper = key.toUpperCase();
        if (upper === "PATH" || upper === "PATHEXT") {
          normalized[upper] = value;
        }
      }
    }
  }
  return normalized;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function isPythonServerId(serverId: string): boolean {
  return serverId === "pyright" || serverId === "basedpyright";
}
