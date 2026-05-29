import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  Definition,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { detectFiletype } from "../detect/filetypes.js";
import { detectRoot } from "../detect/root.js";
import type { LoadLspConfigResult } from "../config/loadConfig.js";
import type { LspInstallManager } from "../install/manager.js";
import { readLockfile, type LockfileOptions } from "../install/lockfile.js";
import type { InstalledServerMetadata, ServerDefinition } from "../registry/schema.js";
import { resolveServerConfig } from "../resolve/resolveServer.js";
import type { LspProcessRegistry } from "./processRegistry.js";
import { LspClient, type LspConnectionFactory, type LspDiagnosticsResult, type LspServerSpawner } from "./client.js";

export interface LspRuntimeManagerOptions {
  cwd: string;
  ownerId: string;
  config: LoadLspConfigResult;
  installManager: LspInstallManager;
  processRegistry: LspProcessRegistry;
  spawner?: LspServerSpawner;
  connectionFactory?: LspConnectionFactory;
  lockfileOptions?: LockfileOptions;
  requestTimeoutMs?: number;
  diagnosticsWaitMs?: number;
  shutdownGraceMs?: number;
}

export type LspStartStatus = "started" | "already-running" | "missing" | "declined" | "error";

export interface LspStartResult {
  serverId: string;
  rootDir: string;
  status: LspStartStatus;
  message: string;
  installedNow?: boolean;
}

export interface LspRuntimeFileResult<T> {
  serverId: string;
  rootDir: string;
  filePath: string;
  uri: string;
  result: T;
}

export interface LspWorkspaceSymbolsResult {
  serverId: string;
  rootDir: string;
  result: SymbolInformation[] | WorkspaceSymbol[] | null;
}

interface SelectedServer {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  filetype: string;
  filePath: string;
  text: string;
}

interface ClientTarget {
  client: LspClient;
  serverId: string;
  rootDir: string;
  started: boolean;
}

interface ClientShutdownResult {
  client: LspClient;
  stopped: boolean;
}

interface ClientStartOptions {
  allowPromptInstall: boolean;
}

interface EnsureClientInput {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  allowPromptInstall: boolean;
}

interface StartClientInput extends EnsureClientInput {
  key: string;
}

export class LspRuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no-filetype"
      | "no-server"
      | "not-installed"
      | "declined"
      | "start-failed"
      | "outside-workspace"
      | "invalid-position",
  ) {
    super(message);
    this.name = "LspRuntimeError";
  }
}

export class LspRuntimeManager {
  private readonly cwd: string;
  private readonly ownerId: string;
  private readonly config: LoadLspConfigResult;
  private readonly installManager: LspInstallManager;
  private readonly processRegistry: LspProcessRegistry;
  private readonly spawner?: LspServerSpawner;
  private readonly connectionFactory?: LspConnectionFactory;
  private readonly lockfileOptions: LockfileOptions;
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsWaitMs: number;
  private readonly shutdownGraceMs: number;
  private readonly clients = new Map<string, LspClient>();
  private readonly starting = new Map<string, Promise<ClientTarget>>();

  constructor(options: LspRuntimeManagerOptions) {
    this.cwd = options.cwd;
    this.ownerId = options.ownerId;
    this.config = options.config;
    this.installManager = options.installManager;
    this.processRegistry = options.processRegistry;
    this.spawner = options.spawner;
    this.connectionFactory = options.connectionFactory;
    this.lockfileOptions = options.lockfileOptions ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.diagnosticsWaitMs = options.diagnosticsWaitMs ?? 350;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
  }

  async startServer(
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspStartResult[]> {
    const targets = serverId ? [serverId] : await this.installedServerIds();
    if (targets.length === 0) return [];

    const results: LspStartResult[] = [];
    for (const targetId of targets) {
      results.push(await this.startServerAtRoot(targetId, this.cwd, options));
    }
    return results;
  }

  async restartServer(
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspStartResult[]> {
    const targetIds = new Set(serverId ? [serverId] : [...this.clients.values()].map((client) => client.serverId));
    if (!serverId && targetIds.size === 0) {
      return this.startServer(undefined, options);
    }

    const stopped = await this.shutdownClients((client) => targetIds.has(client.serverId));
    const failed = stopped.filter((entry) => !entry.stopped);
    if (failed.length > 0) {
      return failed.map(({ client }) => ({
        serverId: client.serverId,
        rootDir: client.rootDir,
        status: "error",
        message: `Could not restart ${client.serverId} for ${client.rootDir}; old process did not exit.`,
      }));
    }

    return this.startServer(serverId, options);
  }

  async shutdown(): Promise<void> {
    await this.shutdownClients(() => true);
  }

  async stopServer(serverId?: string): Promise<number> {
    const stopped = await this.shutdownClients((client) => !serverId || client.serverId === serverId);
    return stopped.filter((entry) => entry.stopped).length;
  }

  async diagnostics(filePath: string): Promise<LspDiagnosticsResult> {
    const target = await this.prepareFileTarget(filePath);
    await delay(this.diagnosticsWaitMs);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      diagnostics: target.client.getDiagnostics(target.uri),
    };
  }

  async hover(filePath: string, line: number, character: number): Promise<LspRuntimeFileResult<Hover | null>> {
    const target = await this.prepareFilePositionTarget(filePath, line, character);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.hover(target.uri, line, character),
    };
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspRuntimeFileResult<Definition | LocationLink[] | null>> {
    const target = await this.prepareFilePositionTarget(filePath, line, character);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.definition(target.uri, line, character),
    };
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = false,
  ): Promise<LspRuntimeFileResult<Location[] | null>> {
    const target = await this.prepareFilePositionTarget(filePath, line, character);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.references(target.uri, line, character, includeDeclaration),
    };
  }

  async documentSymbols(
    filePath: string,
  ): Promise<LspRuntimeFileResult<DocumentSymbol[] | SymbolInformation[] | null>> {
    const target = await this.prepareFileTarget(filePath);
    return {
      serverId: target.client.serverId,
      rootDir: target.client.rootDir,
      filePath: target.filePath,
      uri: target.uri,
      result: await target.client.documentSymbols(target.uri),
    };
  }

  async workspaceSymbols(
    query: string,
    serverId?: string,
    options: ClientStartOptions = { allowPromptInstall: false },
  ): Promise<LspWorkspaceSymbolsResult[]> {
    const clients = serverId
      ? [
          await this.ensureClient({
            server: this.getServer(serverId),
            rootDir: this.cwd,
            allowPromptInstall: options.allowPromptInstall,
          }),
        ]
      : this.workspaceSymbolClients();
    const results: LspWorkspaceSymbolsResult[] = [];
    for (const target of clients) {
      results.push({
        serverId: target.client.serverId,
        rootDir: target.client.rootDir,
        result: await target.client.workspaceSymbols(query),
      });
    }
    return results;
  }

  activeClients(): Array<{ id: string; serverId: string; rootDir: string }> {
    const active: Array<{ id: string; serverId: string; rootDir: string }> = [];
    for (const client of this.clients.values()) {
      if (!client.isExited) active.push({ id: client.id, serverId: client.serverId, rootDir: client.rootDir });
    }
    return active;
  }

  private workspaceSymbolClients(): ClientTarget[] {
    const active: ClientTarget[] = [];
    for (const client of this.clients.values()) {
      if (!client.isExited) active.push({ client, serverId: client.serverId, rootDir: client.rootDir, started: false });
    }
    return active;
  }

  private async prepareFileTarget(filePath: string): Promise<SelectedServer & { client: LspClient; uri: string }> {
    const selected = await this.selectServerForFile(filePath);
    return this.attachClient(selected);
  }

  private async prepareFilePositionTarget(
    filePath: string,
    line: number,
    character: number,
  ): Promise<SelectedServer & { client: LspClient; uri: string }> {
    const selected = await this.selectServerForFile(filePath);
    validatePosition(selected, line, character);
    return this.attachClient(selected);
  }

  private async attachClient(selected: SelectedServer): Promise<SelectedServer & { client: LspClient; uri: string }> {
    const target = await this.ensureClient({
      server: selected.server,
      rootDir: selected.rootDir,
      rootMarker: selected.rootMarker,
      allowPromptInstall: false,
    });
    const uri = await target.client.syncFile(selected.filePath, selected.filetype, selected.text);
    return { ...selected, client: target.client, uri };
  }

  private async selectServerForFile(filePath: string): Promise<SelectedServer> {
    const resolvedPath = this.resolvePath(filePath);
    const text = await readFile(resolvedPath, "utf8");
    const filetype = detectFiletype({ path: resolvedPath, content: text });
    if (!filetype) {
      throw new LspRuntimeError(`No LSP filetype detected for ${resolvedPath}.`, "no-filetype");
    }

    const server = Object.values(this.config.catalog.servers).find((entry) => entry.filetypes.includes(filetype));
    if (!server) {
      throw new LspRuntimeError(
        `No configured LSP server handles filetype ${filetype} for ${resolvedPath}.`,
        "no-server",
      );
    }

    const root = await detectRoot(resolvedPath, server.rootMarkers);
    const rootDir = root && isPathInside(this.cwd, root.rootDir) ? root.rootDir : this.cwd;
    return {
      server,
      rootDir,
      rootMarker: rootDir === root?.rootDir ? root.marker : undefined,
      filetype,
      filePath: resolvedPath,
      text,
    };
  }

  private async startServerAtRoot(
    serverId: string,
    rootDir: string,
    options: ClientStartOptions,
  ): Promise<LspStartResult> {
    try {
      const target = await this.ensureClient({
        server: this.getServer(serverId),
        rootDir,
        allowPromptInstall: options.allowPromptInstall,
      });
      return {
        serverId,
        rootDir: target.rootDir,
        status: target.started ? "started" : "already-running",
        message: target.started
          ? `Started ${serverId} for ${target.rootDir}.`
          : `${serverId} is already running for ${target.rootDir}.`,
      };
    } catch (error) {
      if (error instanceof LspRuntimeError && (error.code === "not-installed" || error.code === "declined")) {
        return {
          serverId,
          rootDir,
          status: error.code === "not-installed" ? "missing" : "declined",
          message: error.message,
        };
      }
      return { serverId, rootDir, status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private getServer(serverId: string): ServerDefinition {
    const server = this.config.catalog.servers[serverId];
    if (!server) throw new LspRuntimeError(`Unknown LSP server: ${serverId}.`, "no-server");
    return server;
  }

  private async ensureClient(input: EnsureClientInput): Promise<ClientTarget> {
    const server = input.server;
    const rootDir = resolve(input.rootDir);
    const key = clientKey(server.id, rootDir);
    const existing = this.clients.get(key);
    if (existing && !existing.isExited) {
      return { client: existing, serverId: server.id, rootDir, started: false };
    }

    const inflight = this.starting.get(key);
    if (inflight) return inflight;

    const start = this.startClient({ ...input, rootDir, key });
    this.starting.set(key, start);
    try {
      return await start;
    } finally {
      this.starting.delete(key);
    }
  }

  private async startClient(input: StartClientInput): Promise<ClientTarget> {
    const install = await this.ensureInstalled(input.server.id, { allowPromptInstall: input.allowPromptInstall });
    const resolved = await resolveServerConfig({
      server: input.server,
      rootDir: input.rootDir,
      rootMarker: input.rootMarker,
      install,
    });
    let client: LspClient | undefined;
    try {
      client = new LspClient({
        id: input.key,
        ownerId: this.ownerId,
        config: resolved,
        processRegistry: this.processRegistry,
        spawner: this.spawner,
        connectionFactory: this.connectionFactory,
        requestTimeoutMs: this.requestTimeoutMs,
        shutdownGraceMs: this.shutdownGraceMs,
      });
      await client.start();
      this.clients.set(input.key, client);
      return { client, serverId: input.server.id, rootDir: input.rootDir, started: true };
    } catch (error) {
      await client?.shutdown().catch(() => false);
      throw new LspRuntimeError(
        `Failed to start ${input.server.id}: ${error instanceof Error ? error.message : String(error)}`,
        "start-failed",
      );
    }
  }

  private async ensureInstalled(serverId: string, options: ClientStartOptions): Promise<InstalledServerMetadata> {
    const lockfile = await readLockfile(this.lockfileOptions);
    const existing = lockfile.servers[serverId];
    if (existing) return existing;

    if (!options.allowPromptInstall && this.config.installMode !== "auto") {
      throw new LspRuntimeError(
        `${serverId} is not installed. Run /lsp install ${serverId} to install it explicitly.`,
        "not-installed",
      );
    }

    const result = await this.installManager.ensureInstalled(serverId);
    if (result.status === "installed") return result.metadata;
    throw new LspRuntimeError(result.message, result.status === "declined" ? "declined" : "not-installed");
  }

  private async installedServerIds(): Promise<string[]> {
    const lockfile = await readLockfile(this.lockfileOptions);
    return Object.keys(lockfile.servers).filter((serverId) => this.config.catalog.servers[serverId] !== undefined);
  }

  private async shutdownClients(predicate: (client: LspClient) => boolean): Promise<ClientShutdownResult[]> {
    const entries = [...this.clients.entries()].filter(([_key, client]) => predicate(client));
    const stopped = await Promise.all(
      entries.map(async ([key, client]) => {
        const didStop = await client.shutdown();
        if (didStop || client.isExited) this.clients.delete(key);
        return { client, stopped: didStop || client.isExited };
      }),
    );
    return stopped;
  }

  private resolvePath(filePath: string): string {
    const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(this.cwd, filePath);
    if (!isPathInside(this.cwd, resolvedPath)) {
      throw new LspRuntimeError(
        `Refusing to start LSP for ${resolvedPath}; target is outside workspace ${this.cwd}.`,
        "outside-workspace",
      );
    }
    return resolvedPath;
  }
}

function clientKey(serverId: string, rootDir: string): string {
  return `${serverId}:${rootDir}`;
}

function isPathInside(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(resolve(rootDir), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function validatePosition(selected: SelectedServer, line: number, character: number): void {
  const lines = splitLines(selected.text);
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
    throw new LspRuntimeError(
      `Invalid LSP position for ${selected.filePath}. Use a valid 1-based line/column from the file and place the column on an identifier token.`,
      "invalid-position",
    );
  }

  if (line >= lines.length) {
    throw new LspRuntimeError(
      `Position is outside ${selected.filePath}: line ${line + 1} was requested, but the file has ${lines.length} line(s). Use a valid 1-based line/column from the file and place the column on an identifier token.`,
      "invalid-position",
    );
  }

  const maxCharacter = lines[line]?.length ?? 0;
  if (character > maxCharacter) {
    throw new LspRuntimeError(
      `Position is outside ${selected.filePath}: column ${character + 1} was requested on line ${line + 1}, but the maximum column is ${maxCharacter + 1}. Place the column on the identifier token you want to inspect.`,
      "invalid-position",
    );
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
