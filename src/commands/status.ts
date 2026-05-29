import type { LoadLspConfigResult } from "../config/loadConfig.js";
import type { LspLockfile } from "../install/lockfile.js";
import type { LspProcessEntry } from "../lsp/processRegistry.js";
import type { ServerDefinition } from "../registry/schema.js";

export interface LspStatusSnapshot {
  config: LoadLspConfigResult;
  lockfile: LspLockfile;
  processes: LspProcessEntry[];
}

export function formatLspStatus(snapshot: LspStatusSnapshot): string {
  const lines = ["LSP status", ""];
  lines.push(`installMode: ${snapshot.config.installMode}`);
  lines.push(`servers: ${Object.keys(snapshot.config.catalog.servers).length}`);
  lines.push(`tracked processes: ${snapshot.processes.length}`);

  if (snapshot.config.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of snapshot.config.warnings) lines.push(`- ${warning}`);
  }

  lines.push("", "servers:");
  for (const server of Object.values(snapshot.config.catalog.servers)) {
    const installed = snapshot.lockfile.servers[server.id] ? "installed" : "missing";
    const processCount = snapshot.processes.filter((process) => process.serverId === server.id).length;
    lines.push(`- ${server.id}: ${installed}, ${processCount} process${processCount === 1 ? "" : "es"}`);
  }

  return lines.join("\n");
}

export function formatLspDoctor(snapshot: LspStatusSnapshot, serverId?: string): string {
  if (serverId) {
    const server = snapshot.config.catalog.servers[serverId];
    if (!server) return `Unknown LSP server: ${serverId}`;
    return formatServerDoctor(server, snapshot);
  }

  return [formatLspStatus(snapshot), "", "Run /lsp doctor <serverId> for resolved server details."].join("\n");
}

function formatServerDoctor(server: ServerDefinition, snapshot: LspStatusSnapshot): string {
  const lockEntry = snapshot.lockfile.servers[server.id];
  const processes = snapshot.processes.filter((process) => process.serverId === server.id);
  const lines = [
    `server: ${server.id}`,
    `displayName: ${server.displayName}`,
    `filetypes: ${server.filetypes.join(", ")}`,
    `rootMarkers: ${server.rootMarkers.join(", ")}`,
    `install: ${server.install.type}`,
    `lazy: ${server.lazy ? "yes" : "no"}`,
    `installed: ${lockEntry ? "yes" : "no"}`,
  ];

  if (lockEntry) {
    lines.push(`resolvedCommand: ${lockEntry.resolvedCommand.join(" ")}`);
    if (lockEntry.requestedVersion) lines.push(`requestedVersion: ${lockEntry.requestedVersion}`);
    if (lockEntry.packageDir) lines.push(`packageDir: ${lockEntry.packageDir}`);
  }

  if (processes.length > 0) {
    lines.push("processes:");
    for (const process of processes) {
      lines.push(`- pid ${process.pid} root=${process.rootDir} owner=${process.ownerId}`);
    }
  } else {
    lines.push("processes: none");
  }

  const relevantWarnings = snapshot.config.warnings.filter((warning) => warning.includes(server.id));
  if (relevantWarnings.length > 0) {
    lines.push("warnings:");
    for (const warning of relevantWarnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}
