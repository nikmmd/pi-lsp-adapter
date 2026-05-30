import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getBinDir,
  getCacheDir,
  getLockfilePath,
  getLogsDir,
  getManagedLspRoot,
  getPackagesDir,
  getProcessRegistryDir,
  getRegistryDir,
  getWorkspacesDir,
} from "../config/paths.js";
import { InstalledServerMetadataSchema } from "../registry/schema.js";
import type { InstalledServerMetadata, InstallerType } from "../registry/schema.js";
import { isNodeError, isPlainObject, messageFromError } from "../util/helpers.js";
import { Value } from "typebox/value";
import { ConfigError } from "../util/errors.js";

export interface LspLockfile {
  servers: Record<string, InstalledServerMetadata>;
}

export interface LockfileOptions {
  lockfilePath?: string;
}

export interface CreateInstalledServerMetadataInput {
  installer: InstallerType;
  requestedVersion?: string;
  packages?: Record<string, string>;
  resolvedCommand: string[];
  packageDir?: string;
  binDir?: string;
  installedAt?: Date;
}

export async function ensureManagedLspRoot(): Promise<void> {
  await Promise.all([
    mkdir(getManagedLspRoot(), { recursive: true }),
    mkdir(getRegistryDir(), { recursive: true }),
    mkdir(getPackagesDir(), { recursive: true }),
    mkdir(getBinDir(), { recursive: true }),
    mkdir(getCacheDir(), { recursive: true }),
    mkdir(getLogsDir(), { recursive: true }),
    mkdir(getWorkspacesDir(), { recursive: true }),
    mkdir(getProcessRegistryDir(), { recursive: true }),
  ]);
}

export async function readLockfile(options: LockfileOptions = {}): Promise<LspLockfile> {
  const lockfilePath = options.lockfilePath ?? getLockfilePath();
  const paths = options.lockfilePath ? [lockfilePath] : [lockfilePath, getLegacyLockfilePath(lockfilePath)];

  for (const path of paths) {
    try {
      return await readLockfileAt(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }

  return { servers: {} };
}

async function readLockfileAt(lockfilePath: string): Promise<LspLockfile> {
  const raw = await readFile(lockfilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Invalid LSP lockfile at ${lockfilePath}: ${messageFromError(error)}`);
  }

  if (!isLockfile(parsed)) {
    throw new ConfigError(
      `Invalid LSP lockfile at ${lockfilePath}: expected { servers: { ... } } with valid server metadata.`,
    );
  }

  return { servers: parsed.servers };
}

function getLegacyLockfilePath(lockfilePath: string): string {
  return join(dirname(lockfilePath), "lock.json");
}

export async function writeLockfile(lockfile: LspLockfile, options: LockfileOptions = {}): Promise<void> {
  const lockfilePath = options.lockfilePath ?? getLockfilePath();
  await ensureManagedLspRoot();
  await mkdir(dirname(lockfilePath), { recursive: true });

  const tempPath = `${lockfilePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalizeLockfile(lockfile), null, 2)}\n`, "utf8");
  await rename(tempPath, lockfilePath);
}

export async function writeServerLockfileEntry(
  serverId: string,
  metadata: InstalledServerMetadata,
  options: LockfileOptions = {},
): Promise<LspLockfile> {
  const lockfile = await readLockfile(options);
  lockfile.servers[serverId] = metadata;
  await writeLockfile(lockfile, options);
  return lockfile;
}

export async function removeServerLockfileEntry(serverId: string, options: LockfileOptions = {}): Promise<LspLockfile> {
  const lockfile = await readLockfile(options);
  delete lockfile.servers[serverId];
  await writeLockfile(lockfile, options);
  return lockfile;
}

export function createInstalledServerMetadata(input: CreateInstalledServerMetadataInput): InstalledServerMetadata {
  const metadata: InstalledServerMetadata = {
    installer: input.installer,
    resolvedCommand: input.resolvedCommand,
    installedAt: (input.installedAt ?? new Date()).toISOString(),
  };

  if (input.requestedVersion !== undefined) {
    metadata.requestedVersion = input.requestedVersion;
  }

  if (input.packages !== undefined) {
    metadata.packages = input.packages;
  }

  if (input.packageDir !== undefined) {
    metadata.packageDir = input.packageDir;
  }

  if (input.binDir !== undefined) {
    metadata.binDir = input.binDir;
  }

  return metadata;
}

function normalizeLockfile(lockfile: LspLockfile): LspLockfile {
  return {
    servers: Object.fromEntries(Object.entries(lockfile.servers).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function isLockfile(value: unknown): value is LspLockfile {
  if (!isPlainObject(value) || !isPlainObject(value.servers)) {
    return false;
  }

  return Object.values(value.servers).every(isInstalledServerMetadata);
}

function isInstalledServerMetadata(value: unknown): value is InstalledServerMetadata {
  return Value.Check(InstalledServerMetadataSchema, value);
}
