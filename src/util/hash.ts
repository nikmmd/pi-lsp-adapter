import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function stableHash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function hashPath(path: string, length = 16): string {
  return stableHash(resolve(path), length);
}
