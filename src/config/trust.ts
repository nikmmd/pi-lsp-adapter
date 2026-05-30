import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isNodeError } from "../util/helpers.js";
import { getTrustStorePath } from "./paths.js";

export interface TrustStore {
  trustedProjects: string[];
}

export interface TrustStoreOptions {
  trustStorePath?: string;
}

export async function loadTrustStore(options: TrustStoreOptions = {}): Promise<TrustStore> {
  const trustStorePath = options.trustStorePath ?? getTrustStorePath();

  try {
    const raw = await readFile(trustStorePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isTrustStore(parsed)) {
      return { trustedProjects: [] };
    }

    const trustedProjects = [...new Set(parsed.trustedProjects.filter((entry) => entry.length > 0))].sort();
    return { trustedProjects };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { trustedProjects: [] };
    }
    return { trustedProjects: [] };
  }
}

export async function isProjectTrusted(rootDir: string, options: TrustStoreOptions = {}): Promise<boolean> {
  const canonicalRoot = await canonicalizePath(rootDir);
  const store = await loadTrustStore(options);
  return store.trustedProjects.includes(canonicalRoot);
}

export async function trustProject(rootDir: string, options: TrustStoreOptions = {}): Promise<TrustStore> {
  const canonicalRoot = await canonicalizePath(rootDir);
  const store = await loadTrustStore(options);
  if (!store.trustedProjects.includes(canonicalRoot)) {
    store.trustedProjects.push(canonicalRoot);
    store.trustedProjects.sort();
  }

  await writeTrustStore(store, options);
  return store;
}

export async function untrustProject(rootDir: string, options: TrustStoreOptions = {}): Promise<TrustStore> {
  const canonicalRoot = await canonicalizePath(rootDir);
  const store = await loadTrustStore(options);
  store.trustedProjects = store.trustedProjects.filter((entry) => entry !== canonicalRoot);
  await writeTrustStore(store, options);
  return store;
}

async function writeTrustStore(store: TrustStore, options: TrustStoreOptions = {}): Promise<void> {
  const trustStorePath = options.trustStorePath ?? getTrustStorePath();
  await mkdir(dirname(trustStorePath), { recursive: true });

  const tempPath = `${trustStorePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify({ trustedProjects: [...new Set(store.trustedProjects)].sort() }, null, 2)}\n`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, trustStorePath);
}

async function canonicalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isTrustStore(value: unknown): value is TrustStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const trustedProjects = (value as { trustedProjects?: unknown }).trustedProjects;
  return Array.isArray(trustedProjects) && trustedProjects.every((entry) => typeof entry === "string");
}


