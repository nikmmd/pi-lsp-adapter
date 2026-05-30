import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InitializeRequest, HoverRequest, PublishDiagnosticsNotification } from "vscode-languageserver-protocol";
import type { Disposable } from "vscode-jsonrpc";
import { LspClient, type LspConnection, type LspServerProcess } from "../../src/lsp/client.js";
import { LspProcessRegistry, type ProcessProbe } from "../../src/lsp/processRegistry.js";
import type { ResolvedServerConfig } from "../../src/registry/schema.js";

let tempDir: string;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-lsp-client-"));
  registryPath = join(tempDir, "lsp.pid.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function fakeProbe(): ProcessProbe {
  return {
    isRunning: () => true,
    commandMatches: () => true,
    terminate: () => undefined,
  };
}

function fakeRegistry(unregister: () => Promise<unknown> = async () => undefined): LspProcessRegistry {
  return {
    register: async () => undefined,
    unregister,
  } as never;
}

function config(rootDir: string): ResolvedServerConfig {
  return {
    server: {
      id: "test-ls",
      displayName: "Test LSP",
      filetypes: ["typescript"],
      rootMarkers: ["package.json"],
      install: { type: "system", command: ["test-ls"] },
      command: ["test-ls", "--stdio"],
      env: {},
      settings: {},
      initializationOptions: {},
      lazy: true,
    },
    rootDir,
    command: ["test-ls", "--stdio"],
    cwd: rootDir,
    env: {},
    settings: {},
    initializationOptions: {},
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

class FakeConnection implements LspConnection {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandler: ((method: string) => unknown) | undefined;

  constructor(
    private readonly capabilities: Record<string, unknown> = {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    },
  ) {}

  listen(): void {}

  async sendRequest<R>(method: string, _params?: unknown): Promise<R> {
    if (this.requestHandler) return this.requestHandler(method) as R;
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
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }

  emitNotification(method: string, params: unknown): void {
    this.notificationHandlers.get(method)?.(params);
  }

  onRequest(): Disposable {
    return { dispose: () => undefined };
  }

  dispose(): void {}
  end(): void {}
}

describe("LspClient", () => {
  it("constructs and starts with valid pid", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    expect(client.serverId).toBe("test-ls");
    expect(client.rootDir).toBe(tempDir);
    expect(client.isExited).toBe(false);

    await client.start();

    expect(connection.notifications.some((n) => n.method === InitializeRequest.method)).toBe(false);
    expect(client.isExited).toBe(false);
  });

  it("throws when pid is invalid", () => {
    const process = { pid: 0 } as LspServerProcess;
    expect(
      () =>
        new LspClient({
          id: "bad-pid:/repo",
          ownerId: "test",
          config: config(tempDir),
          processRegistry: {} as never,
          spawner: () => process,
        }),
    ).toThrow("did not expose a valid pid");
  });

  it("syncs a new file and sends DidOpen", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const uri = await client.syncFile(join(tempDir, "index.ts"), "typescript", "const x = 1;\n");

    expect(uri).toContain(tempDir);
    const didOpen = connection.notifications.find((n) => n.method === "textDocument/didOpen");
    expect(didOpen).toBeDefined();
    expect(didOpen!.params).toMatchObject({
      textDocument: { languageId: "typescript", version: 1, text: "const x = 1;\n" },
    });
  });

  it("syncs a changed file and sends DidChange", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const uri = await client.syncFile(join(tempDir, "index.ts"), "typescript", "const x = 1;\n");
    await client.syncFile(join(tempDir, "index.ts"), "typescript", "const x = 2;\n");

    const didChange = connection.notifications.find((n) => n.method === "textDocument/didChange");
    expect(didChange).toBeDefined();
    expect(didChange!.params).toMatchObject({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "const x = 2;\n" }],
    });
  });

  it("does not send notification when file content is unchanged", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    await client.syncFile(join(tempDir, "index.ts"), "typescript", "const x = 1;\n");
    const notifCountBefore = connection.notifications.length;
    await client.syncFile(join(tempDir, "index.ts"), "typescript", "const x = 1;\n");

    expect(connection.notifications.length).toBe(notifCountBefore);
  });

  it("records diagnostics from PublishDiagnosticsNotification", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    connection.emitNotification(PublishDiagnosticsNotification.method, {
      uri: "file:///repo/index.ts",
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: "error",
          source: "test-ls",
        },
      ],
    });

    const diags = client.getDiagnostics("file:///repo/index.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("error");
  });

  it("returns empty diagnostics for unknown uri", () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    const diags = client.getDiagnostics("file:///repo/unknown.ts");
    expect(diags).toEqual([]);
  });

  it("throws when requesting unsupported capability", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection({}); // no capabilities
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    await expect(client.hover("file:///repo/index.ts", 0, 0)).rejects.toThrow("test-ls does not support LSP hover");
  });

  it("performs hover request", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const result = await client.hover("file:///repo/index.ts", 0, 0);
    expect(result).toMatchObject({ contents: { value: "hover text" } });
  });

  it("performs definition request", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const result = await client.definition("file:///repo/index.ts", 0, 0);
    expect(result).toBeNull();
  });

  it("performs references request", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const result = await client.references("file:///repo/index.ts", 0, 0, false);
    expect(result).toBeNull();
  });

  it("performs documentSymbols request", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const result = await client.documentSymbols("file:///repo/index.ts");
    expect(result).toBeNull();
  });

  it("performs workspaceSymbols request", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    const result = await client.workspaceSymbols("test");
    expect(result).toBeNull();
  });

  it("shuts down gracefully when process exits", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = fakeRegistry();

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
      shutdownGraceMs: 500,
    });

    await client.start();

    const result = await client.shutdown();
    expect(result).toBe(true);
    expect(client.isExited).toBe(true);
  });

  it("uses SIGTERM and SIGKILL when graceful shutdown fails", async () => {
    const process = new (class extends FakeProcess {
      killCount = 0;
      kill(signal?: NodeJS.Signals): boolean {
        this.killCount += 1;
        // Don't emit exit on first SIGTERM — simulate stubborn process
        if (this.killCount === 1) return true;
        return super.kill(signal);
      }
    })(9999);
    const connection = new FakeConnection();
    const registry = fakeRegistry();

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
      shutdownGraceMs: 10,
    });

    await client.start();

    const result = await client.shutdown();
    expect(result).toBe(true);
  });

  it("handles already-exited process on shutdown", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = fakeRegistry();

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    // Don't start, just simulate exit
    process.emit("exit", 0, null);

    const result = await client.shutdown();
    expect(result).toBe(true);
  });

  it("handles process error event", async () => {
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "test", probe: fakeProbe() });

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    process.emit("error", new Error("spawn failed"));
    expect(client.isExited).toBe(true);
  });

  it("unregisters from process registry on exit", async () => {
    const unregisterSpy = vi.fn().mockResolvedValue(undefined);
    const process = new FakeProcess(9999);
    const connection = new FakeConnection();
    const registry = fakeRegistry(unregisterSpy);

    const client = new LspClient({
      id: "test-ls:/repo",
      ownerId: "test",
      config: config(tempDir),
      processRegistry: registry,
      spawner: () => process,
      connectionFactory: () => connection,
    });

    await client.start();

    process.emit("exit", 0, null);

    expect(unregisterSpy).toHaveBeenCalledWith("test-ls:/repo", 9999);
  });
});
