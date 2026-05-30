import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getBinDir } from "../config/paths.js";
import type { Catalog, InstallMode, InstalledServerMetadata, ServerDefinition } from "../registry/schema.js";
import { ConfigError } from "../util/errors.js";
import {
  getInstallBinName,
  getServerPackageDir,
  installServerBackend,
  type InstallerOptions,
  type InstallerResult,
} from "./installers.js";
import { readLockfile, removeServerLockfileEntry, writeServerLockfileEntry, type LockfileOptions } from "./lockfile.js";

export type InstallConfirmer = (request: InstallConfirmationRequest) => Promise<boolean>;

export interface InstallConfirmationRequest {
  server: ServerDefinition;
  command: string;
}

export type BackendInstaller = (
  server: ServerDefinition,
  requestedVersion: string | undefined,
  options: InstallerOptions,
) => Promise<InstallerResult>;

export interface LspInstallManagerOptions {
  catalog: Catalog;
  installMode?: InstallMode;
  confirmer?: InstallConfirmer;
  backendInstaller?: BackendInstaller;
  installerOptions?: InstallerOptions;
  lockfileOptions?: LockfileOptions;
}

export type EnsureInstalledResult =
  | {
      status: "installed";
      serverId: string;
      metadata: InstalledServerMetadata;
      installedNow: boolean;
    }
  | {
      status: "missing" | "declined";
      serverId: string;
      installCommand: string;
      message: string;
    };

export interface InstallOperationResult {
  serverId: string;
  metadata: InstalledServerMetadata;
  logPath: string;
}

export interface UninstallOperationResult {
  serverId: string;
  removed: boolean;
}

export class LspInstallManager {
  private readonly catalog: Catalog;
  private readonly installMode: InstallMode;
  private readonly confirmer?: InstallConfirmer;
  private readonly backendInstaller: BackendInstaller;
  private readonly installerOptions: InstallerOptions;
  private readonly lockfileOptions: LockfileOptions;
  private installQueue: Promise<void> = Promise.resolve();

  constructor(options: LspInstallManagerOptions) {
    this.catalog = options.catalog;
    this.installMode = options.installMode ?? "prompt";
    this.confirmer = options.confirmer;
    this.backendInstaller = options.backendInstaller ?? installServerBackend;
    this.installerOptions = options.installerOptions ?? {};
    this.lockfileOptions = options.lockfileOptions ?? {};
  }

  async ensureInstalled(serverId: string, requestedVersion?: string): Promise<EnsureInstalledResult> {
    const server = this.getServer(serverId);
    const lockfile = await readLockfile(this.lockfileOptions);
    const existing = lockfile.servers[serverId];
    if (existing && requestedVersion === undefined) {
      return { status: "installed", serverId, metadata: existing, installedNow: false };
    }

    const installCommand = formatInstallCommand(serverId, requestedVersion);

    if (this.installMode === "off") {
      return {
        status: "missing",
        serverId,
        installCommand,
        message: `${serverId} is not installed. Install mode is off; run ${installCommand} to install it explicitly.`,
      };
    }

    if (this.installMode === "prompt") {
      if (!this.confirmer) {
        return {
          status: "missing",
          serverId,
          installCommand,
          message: `${serverId} is not installed. Run ${installCommand} to install it.`,
        };
      }

      const accepted = await this.confirmer({ server, command: installCommand });
      if (!accepted) {
        return {
          status: "declined",
          serverId,
          installCommand,
          message: `${serverId} is not installed; installation was declined.`,
        };
      }
    }

    const installed = await this.installServer(serverId, requestedVersion);
    return { status: "installed", serverId, metadata: installed.metadata, installedNow: true };
  }

  async installServer(serverId: string, requestedVersion?: string): Promise<InstallOperationResult> {
    return this.enqueueInstall(async () => {
      const server = this.getServer(serverId);
      const result = await this.backendInstaller(server, requestedVersion, this.installerOptions);
      await writeServerLockfileEntry(serverId, result.metadata, this.lockfileOptions);
      return { serverId, metadata: result.metadata, logPath: result.logPath };
    });
  }

  async updateServer(serverId: string, requestedVersion?: string): Promise<InstallOperationResult> {
    return this.installServer(serverId, requestedVersion);
  }

  async uninstallServer(serverId: string): Promise<UninstallOperationResult> {
    return this.enqueueInstall(async () => {
      const server = this.getServer(serverId);
      const lockfile = await readLockfile(this.lockfileOptions);
      const existed = lockfile.servers[serverId] !== undefined;

      await removeServerLockfileEntry(serverId, this.lockfileOptions);
      await rm(getServerPackageDir(serverId), { recursive: true, force: true });
      await removeManagedBin(server);

      return { serverId, removed: existed };
    });
  }

  private getServer(serverId: string): ServerDefinition {
    const server = this.catalog.servers[serverId];
    if (!server) {
      throw new ConfigError(`Unknown LSP server: ${serverId}`);
    }
    return server;
  }

  private enqueueInstall<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.installQueue.then(operation, operation);
    this.installQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function formatInstallCommand(serverId: string, requestedVersion?: string): string {
  return `/lsp install ${requestedVersion ? `${serverId}@${requestedVersion}` : serverId}`;
}

async function removeManagedBin(server: ServerDefinition): Promise<void> {
  if (server.install.type === "system") return;
  const binName = getInstallBinName(server);
  await rm(join(getBinDir(), binName), { force: true });
}
