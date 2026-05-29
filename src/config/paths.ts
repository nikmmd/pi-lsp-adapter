import { homedir } from "node:os";
import { join } from "node:path";

export function getManagedLspRoot(): string {
  return join(homedir(), ".pi", "agent", "lsp");
}

export function getRegistryDir(): string {
  return join(getManagedLspRoot(), "registry");
}

export function getPackagesDir(): string {
  return join(getManagedLspRoot(), "packages");
}

export function getBinDir(): string {
  return join(getManagedLspRoot(), "bin");
}

export function getCacheDir(): string {
  return join(getManagedLspRoot(), "cache");
}

export function getLogsDir(): string {
  return join(getManagedLspRoot(), "logs");
}

export function getLockfilePath(): string {
  return join(getManagedLspRoot(), "lsp.lock.json");
}

export function getWorkspacesDir(): string {
  return join(getManagedLspRoot(), "workspaces");
}

export function getProcessRegistryPath(): string {
  return join(getManagedLspRoot(), "lsp.pid.json");
}

export function getTrustStorePath(): string {
  return join(getManagedLspRoot(), "trust.json");
}

export function getUserConfigPath(): string {
  return join(homedir(), ".pi", "agents", "lsp.json");
}

export function getProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "lsp.json");
}
