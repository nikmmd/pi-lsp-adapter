import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
} from "vscode-languageserver-protocol";
import type { Disposable } from "vscode-jsonrpc";
import { LspRuntimeManager } from "../../src/lsp/runtimeManager.js";
import type { LspConnection, LspServerProcess } from "../../src/lsp/client.js";
import { LspProcessRegistry, type ProcessProbe } from "../../src/lsp/processRegistry.js";
import type { LspInstallManager } from "../../src/install/manager.js";
import type { LoadLspConfigResult } from "../../src/config/loadConfig.js";
import type { ServerDefinition } from "../../src/registry/schema.js";

let tempDir: string;
let projectDir: string;
let registryPath: string;
let nextPid: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-lsp-runtime-"));
  projectDir = join(tempDir, "project");
  registryPath = join(tempDir, "lsp.pid.json");
  nextPid = 5000;
  await mkdir(join(projectDir, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("LspRuntimeManager", () => {
  it("starts the configured server for a file, syncs it, records diagnostics, and registers the pid", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "const value: string = 1;\n", "utf8");
    const connections: FakeConnection[] = [];
    const runtime = runtimeManager({
      connectionFactory: (process) => {
        const connection = new FakeConnection(process.pid!);
        connections.push(connection);
        return connection;
      },
    });

    const result = await runtime.diagnostics("src/index.ts");

    expect(result.serverId).toBe("vtsls");
    expect(result.rootDir).toBe(projectDir);
    expect(result.diagnostics[0]?.message).toBe("Type mismatch");
    expect(
      connections[0]?.notifications.find((entry) => entry.method === DidOpenTextDocumentNotification.method),
    ).toMatchObject({
      method: DidOpenTextDocumentNotification.method,
      params: { textDocument: { languageId: "typescript" } },
    });
    await expect(runtime.registry.list()).resolves.toEqual([
      expect.objectContaining({ serverId: "vtsls", rootDir: projectDir, pid: 5000, ownerPid: process.pid }),
    ]);
  });

  it("falls back to cwd as root when no root marker is found", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager();

    const result = await runtime.hover("src/index.ts", 0, 0);

    expect(result.rootDir).toBe(projectDir);
    expect(result.result?.contents).toMatchObject({ value: "hover text" });
  });

  it("rejects out-of-range positions before sending noisy LSP requests", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.hover("src/index.ts", 99, 0)).rejects.toThrow(
      "line 100 was requested, but the file has 2 line(s)",
    );
    await expect(runtime.hover("src/index.ts", 0, 99)).rejects.toThrow("column 100 was requested on line 1");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("reports missing installed metadata without spawning", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ installed: false });

    const results = await runtime.startServer("vtsls");

    expect(results[0]).toMatchObject({ status: "missing" });
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("does not trigger prompt installs from file-based runtime calls", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ installMode: "prompt" });

    await expect(runtime.diagnostics("src/index.ts")).rejects.toThrow("Run /lsp install vtsls");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("refuses to start workspaces for files outside cwd", async () => {
    const outsideFile = join(tempDir, "outside.ts");
    await writeFile(outsideFile, "export const outside = 1;\n", "utf8");
    const runtime = runtimeManager();

    await expect(runtime.diagnostics(outsideFile)).rejects.toThrow("outside workspace");
    await expect(runtime.registry.list()).resolves.toEqual([]);
  });

  it("queries only active clients for workspace symbols when no server id is provided", async () => {
    const connections: FakeConnection[] = [];
    const runtime = runtimeManager({
      connectionFactory: (process) => {
        const connection = new FakeConnection(process.pid!);
        connections.push(connection);
        return connection;
      },
    });

    await expect(runtime.workspaceSymbols("value")).resolves.toEqual([]);

    expect(connections).toEqual([]);
  });

  it("reports unsupported server capabilities before sending a request", async () => {
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const runtime = runtimeManager({ connectionFactory: (process) => new FakeConnection(process.pid!, {}) });

    await expect(runtime.hover("src/index.ts", 0, 0)).rejects.toThrow("does not support LSP hover");
  });

  it("does not replace a client when the old process refuses to exit during restart", async () => {
    await writeFile(join(projectDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    let spawns = 0;
    const runtime = runtimeManager({
      spawner: () => {
        spawns += 1;
        return new NonExitingFakeProcess(nextPid++);
      },
    });

    await runtime.diagnostics("src/index.ts");
    const result = await runtime.restartServer("vtsls");

    expect(result[0]).toMatchObject({ status: "error" });
    expect(spawns).toBe(1);
    await expect(runtime.registry.list()).resolves.toEqual([expect.objectContaining({ serverId: "vtsls", pid: 5000 })]);
  });
});

function runtimeManager(
  options: {
    installed?: boolean;
    installMode?: LoadLspConfigResult["installMode"];
    spawner?: () => LspServerProcess;
    connectionFactory?: (process: LspServerProcess) => LspConnection;
  } = {},
): LspRuntimeManager & {
  registry: LspProcessRegistry;
} {
  const registry = new LspProcessRegistry({
    path: registryPath,
    ownerId: "owner-test",
    probe: fakeProbe(),
    terminateGraceMs: 0,
  });
  const runtime = new LspRuntimeManager({
    cwd: projectDir,
    ownerId: "owner-test",
    config: config(options.installMode ?? "auto"),
    installManager: fakeInstallManager(options.installed ?? true),
    processRegistry: registry,
    lockfileOptions: { lockfilePath: join(tempDir, "lsp.lock.json") },
    spawner: options.spawner ?? (() => new FakeProcess(nextPid++)),
    connectionFactory: options.connectionFactory ?? ((process) => new FakeConnection(process.pid!)),
    diagnosticsWaitMs: 0,
    requestTimeoutMs: 500,
    shutdownGraceMs: 0,
  }) as LspRuntimeManager & { registry: LspProcessRegistry };
  runtime.registry = registry;
  return runtime;
}

function config(installMode: LoadLspConfigResult["installMode"]): LoadLspConfigResult {
  return {
    catalog: { servers: { vtsls: serverDefinition() } },
    warnings: [],
    installMode,
  };
}

function serverDefinition(): ServerDefinition {
  return {
    id: "vtsls",
    displayName: "VTSLS",
    filetypes: ["typescript"],
    rootMarkers: ["package.json"],
    install: { type: "system", command: ["fake-ls"] },
    command: ["fake-ls", "--stdio"],
    env: {},
    settings: {},
    initializationOptions: {},
    lazy: true,
  };
}

function fakeInstallManager(installed: boolean): LspInstallManager {
  return {
    ensureInstalled: async (serverId: string) =>
      installed
        ? {
            status: "installed",
            serverId,
            installedNow: false,
            metadata: {
              installer: "system",
              resolvedCommand: ["fake-ls", "--stdio"],
              installedAt: "2026-05-28T00:00:00.000Z",
            },
          }
        : {
            status: "missing",
            serverId,
            installCommand: `/lsp install ${serverId}`,
            message: `${serverId} is not installed.`,
          },
  } as LspInstallManager;
}

function fakeProbe(): ProcessProbe {
  return {
    isRunning: () => true,
    commandMatches: () => true,
    terminate: () => undefined,
  };
}

class FakeProcess extends EventEmitter implements LspServerProcess {
  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", null, signal ?? null);
    return true;
  }
}

class NonExitingFakeProcess extends EventEmitter implements LspServerProcess {
  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    return true;
  }
}

class FakeConnection implements LspConnection {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(
    private readonly pid: number,
    private readonly capabilities: Record<string, unknown> = {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    },
  ) {}

  listen(): void {}

  async sendRequest<R>(method: string): Promise<R> {
    if (method === InitializeRequest.method) {
      return { capabilities: this.capabilities } as R;
    }
    if (method === HoverRequest.method) {
      return { contents: { kind: "markdown", value: "hover text" } } as R;
    }
    return null as R;
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
    if (method === DidOpenTextDocumentNotification.method && isDidOpenParams(params)) {
      this.notificationHandlers.get(PublishDiagnosticsNotification.method)?.({
        uri: params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            severity: 1,
            message: "Type mismatch",
            source: `fake-${this.pid}`,
          },
        ],
      });
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }

  onRequest(): Disposable {
    return { dispose: () => undefined };
  }

  dispose(): void {}
  end(): void {}
}

function isDidOpenParams(value: unknown): value is { textDocument: { uri: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "textDocument" in value &&
    typeof value.textDocument === "object" &&
    value.textDocument !== null &&
    "uri" in value.textDocument &&
    typeof value.textDocument.uri === "string"
  );
}
