import { isPlainObject } from "./helpers.js";

export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }

  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = deepClone(item);
    }
    return cloned as T;
  }

  return value;
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) {
    return deepClone(base);
  }

  if (Array.isArray(override) || !isPlainObject(override)) {
    return deepClone(override) as T;
  }

  if (!isPlainObject(base)) {
    return deepClone(override) as T;
  }

  const merged: Record<string, unknown> = deepClone(base);
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(merged[key], value);
  }

  return merged as T;
}
