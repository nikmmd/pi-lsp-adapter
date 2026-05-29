import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Disposable,
} from "vscode-jsonrpc/node.js";
import {
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  DocumentSymbolRequest,
  WorkspaceSymbolRequest,
  type Definition,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type LocationLink,
  type ReferenceParams,
  type ServerCapabilities,
  type SymbolInformation,
  type SymbolKind,
  type WorkspaceFolder,
  type WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { JsonObject, JsonValue, ResolvedServerConfig } from "../registry/schema.js";
import type { LspProcessRegistry } from "./processRegistry.js";

export interface LspServerProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface LspConnection {
  listen(): void;
  sendRequest<R>(method: string, params?: unknown): Promise<R>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): Disposable;
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): Disposable;
  dispose(): void;
  end(): void;
}

export type LspServerSpawner = (config: ResolvedServerConfig) => LspServerProcess;
export type LspConnectionFactory = (process: LspServerProcess) => LspConnection;

export interface LspClientOptions {
  id: string;
  ownerId: string;
  config: ResolvedServerConfig;
  processRegistry: LspProcessRegistry;
  spawner?: LspServerSpawner;
  connectionFactory?: LspConnectionFactory;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export interface LspClientDocument {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspDiagnosticsResult {
  serverId: string;
  rootDir: string;
  filePath: string;
  uri: string;
  diagnostics: Diagnostic[];
}

export class LspClient {
  readonly id: string;
  readonly serverId: string;
  readonly rootDir: string;

  private readonly config: ResolvedServerConfig;
  private readonly ownerId: string;
  private readonly processRegistry: LspProcessRegistry;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly pid: number;
  private readonly process: LspServerProcess;
  private readonly connection: LspConnection;
  private readonly diagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly documents = new Map<string, LspClientDocument>();
  private readonly disposables: Disposable[] = [];
  private capabilities: ServerCapabilities | undefined;
  private exited = false;
  private initialized = false;

  constructor(options: LspClientOptions) {
    this.id = options.id;
    this.serverId = options.config.server.id;
    this.rootDir = options.config.rootDir;
    this.config = options.config;
    this.ownerId = options.ownerId;
    this.processRegistry = options.processRegistry;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;

    this.process = (options.spawner ?? defaultSpawner)(options.config);
    if (!this.process.pid || this.process.pid <= 0) {
      throw new Error(`LSP server ${this.serverId} did not expose a valid pid.`);
    }
    this.pid = this.process.pid;

    this.connection = (options.connectionFactory ?? defaultConnectionFactory)(this.process);
    this.registerConnectionHandlers();
    this.process.once("exit", () => {
      this.exited = true;
      void this.processRegistry.unregister(this.id, this.pid);
    });
    this.process.once("error", () => {
      this.exited = true;
    });
  }

  get isExited(): boolean {
    return this.exited;
  }

  async start(): Promise<void> {
    await this.processRegistry.register({
      id: this.id,
      serverId: this.serverId,
      rootDir: this.rootDir,
      pid: this.pid,
      command: this.config.command,
      cwd: this.config.cwd,
      ownerId: this.ownerId,
      ownerPid: process.pid,
    });

    this.connection.listen();
    const result = await this.request<InitializeResult>(InitializeRequest.method, this.initializeParams());
    this.capabilities = result.capabilities;
    await this.connection.sendNotification(InitializedNotification.method, {});
    this.initialized = true;
  }

  async syncFile(filePath: string, languageId: string, text: string): Promise<string> {
    const uri = URI.file(filePath).toString();
    const existing = this.documents.get(uri);
    if (!existing) {
      const document: LspClientDocument = { uri, filePath, languageId, text, version: 1 };
      this.documents.set(uri, document);
      await this.connection.sendNotification(DidOpenTextDocumentNotification.method, {
        textDocument: { uri, languageId, version: document.version, text },
      });
      return uri;
    }

    if (existing.text !== text) {
      existing.version += 1;
      existing.text = text;
      existing.languageId = languageId;
      await this.connection.sendNotification(DidChangeTextDocumentNotification.method, {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
    }

    return uri;
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async hover(uri: string, line: number, character: number): Promise<Hover | null> {
    this.ensureCapability("hover", this.capabilities?.hoverProvider);
    return this.request<Hover | null>(HoverRequest.method, {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async definition(uri: string, line: number, character: number): Promise<Definition | LocationLink[] | null> {
    this.ensureCapability("definition", this.capabilities?.definitionProvider);
    return this.request<Definition | LocationLink[] | null>(DefinitionRequest.method, {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async references(
    uri: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<Location[] | null> {
    this.ensureCapability("references", this.capabilities?.referencesProvider);
    const params: ReferenceParams = {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    };
    return this.request<Location[] | null>(ReferencesRequest.method, params);
  }

  async documentSymbols(uri: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    this.ensureCapability("document symbols", this.capabilities?.documentSymbolProvider);
    return this.request<DocumentSymbol[] | SymbolInformation[] | null>(DocumentSymbolRequest.method, {
      textDocument: { uri },
    });
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[] | WorkspaceSymbol[] | null> {
    this.ensureCapability("workspace symbols", this.capabilities?.workspaceSymbolProvider);
    return this.request<SymbolInformation[] | WorkspaceSymbol[] | null>(WorkspaceSymbolRequest.method, { query });
  }

  async shutdown(): Promise<boolean> {
    if (this.exited) {
      await this.processRegistry.unregister(this.id, this.pid);
      return true;
    }

    try {
      if (this.initialized) {
        await this.request<void>(ShutdownRequest.method, undefined, Math.min(this.requestTimeoutMs, 2_000));
      }
      await this.connection.sendNotification(ExitNotification.method);
    } catch {
      // Shutdown is best-effort; the process registry performs hard cleanup after this.
    } finally {
      for (const disposable of this.disposables) disposable.dispose();
      this.connection.end();
      this.connection.dispose();
    }

    const exited = await this.waitForExit(this.shutdownGraceMs);
    if (exited) {
      await this.processRegistry.unregister(this.id, this.pid);
      return true;
    }

    this.process.kill("SIGTERM");
    const terminated = await this.waitForExit(this.shutdownGraceMs);
    if (terminated) {
      await this.processRegistry.unregister(this.id, this.pid);
      return true;
    }

    this.process.kill("SIGKILL");
    const killed = await this.waitForExit(this.shutdownGraceMs);
    if (killed) await this.processRegistry.unregister(this.id, this.pid);
    return killed;
  }

  private ensureCapability(feature: string, capability: unknown): void {
    if (!capability) {
      throw new Error(`${this.serverId} does not support LSP ${feature}.`);
    }
  }

  private initializeParams(): InitializeParams {
    const rootUri = URI.file(this.rootDir).toString();
    const workspaceFolders: WorkspaceFolder[] = [{ uri: rootUri, name: basename(this.rootDir) || this.rootDir }];

    return {
      processId: process.pid,
      clientInfo: { name: "pi-agent-lsp" },
      rootPath: this.rootDir,
      rootUri,
      workspaceFolders,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: supportedSymbolKinds() },
          },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false, symbolKind: { valueSet: supportedSymbolKinds() } },
        },
      },
      initializationOptions: this.config.initializationOptions,
      trace: "off",
    };
  }

  private registerConnectionHandlers(): void {
    this.disposables.push(
      this.connection.onNotification(PublishDiagnosticsNotification.method, (params) => {
        if (!isPublishDiagnosticsParams(params)) return;
        this.diagnosticsByUri.set(params.uri, params.diagnostics);
      }),
    );

    this.disposables.push(
      this.connection.onRequest("workspace/configuration", (params) =>
        resolveConfigurationRequest(params, this.config.settings),
      ),
      this.connection.onRequest("workspace/workspaceFolders", () => [
        { uri: URI.file(this.rootDir).toString(), name: basename(this.rootDir) },
      ]),
      this.connection.onRequest("client/registerCapability", () => null),
      this.connection.onRequest("client/unregisterCapability", () => null),
      this.connection.onRequest("window/workDoneProgress/create", () => null),
    );
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    return withTimeout(this.connection.sendRequest<T>(method, params), timeoutMs, `${this.serverId} ${method}`);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return new Promise((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
      this.process.once("exit", () => {
        clearTimeout(timeout);
        resolvePromise(true);
      });
    });
  }
}

export function defaultSpawner(config: ResolvedServerConfig): ChildProcessWithoutNullStreams {
  const [command, ...args] = config.command;
  if (!command) throw new Error(`LSP server ${config.server.id} has an empty command.`);
  const child = spawn(command, args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.on("data", () => undefined);
  child.on("error", () => undefined);
  return child;
}

export function defaultConnectionFactory(process: LspServerProcess): LspConnection {
  if (!hasStdio(process)) {
    throw new Error("Cannot create an LSP connection for a process without stdio pipes.");
  }
  return createMessageConnection(
    new StreamMessageReader(process.stdout),
    new StreamMessageWriter(process.stdin),
  ) as LspConnection;
}

function hasStdio(
  process: LspServerProcess,
): process is LspServerProcess & Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout"> {
  return "stdin" in process && "stdout" in process && process.stdin !== null && process.stdout !== null;
}

function supportedSymbolKinds(): SymbolKind[] {
  return Array.from({ length: 26 }, (_value, index) => index + 1) as SymbolKind[];
}

function isPublishDiagnosticsParams(value: unknown): value is { uri: string; diagnostics: Diagnostic[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "uri" in value &&
    typeof value.uri === "string" &&
    "diagnostics" in value &&
    Array.isArray(value.diagnostics)
  );
}

function resolveConfigurationRequest(params: unknown, settings: JsonObject): JsonValue[] {
  if (!isConfigurationParams(params)) return [settings];
  return params.items.map((item) => resolveSection(settings, item.section));
}

function isConfigurationParams(value: unknown): value is { items: Array<{ section?: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items) &&
    value.items.every((item) => typeof item === "object" && item !== null)
  );
}

function resolveSection(settings: JsonObject, section: string | undefined): JsonValue {
  if (!section) return settings;

  let current: JsonValue = settings;
  for (const segment of section.split(".")) {
    if (!isJsonObject(current)) return {};
    const sectionValue: JsonValue | undefined = current[segment];
    if (sectionValue === undefined) return {};
    current = sectionValue;
  }

  return current;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
