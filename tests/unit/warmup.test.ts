import { describe, expect, it, vi } from "vitest";
import { registerLspWarmup } from "../../src/tools/registerLspWarmup.js";
import type { LspExtensionState } from "../../src/state.js";

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: FakeContext) => unknown;

interface FakeContext {
  ui: {
    statuses: Record<string, string | undefined>;
    theme: { fg: (_name: string, text: string) => string };
    setStatus: (key: string, value: string | undefined) => void;
  };
}

describe("registerLspWarmup", () => {
  it("fires read warmup without blocking the read tool call", () => {
    const warmupFile = vi.fn().mockResolvedValue(false);
    const state = fakeState({ warmupFile });
    const handler = registerAndGetHandler(() => state);

    handler(readEvent("src/index.ts"), fakeContext());

    expect(warmupFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("updates the status line after a successful warmup", async () => {
    const warmupFile = vi.fn().mockResolvedValue(true);
    const state = fakeState({
      warmupFile,
      activeClients: () => [{ id: "vtsls:/repo", serverId: "vtsls", rootDir: "/repo" }],
    });
    const handler = registerAndGetHandler(() => state);
    const ctx = fakeContext();

    handler(readEvent("src/index.ts"), ctx);
    await flushPromises();

    expect(ctx.ui.statuses.lsp).toBe("LSP: 1/1 servers");
  });

  it("does not warm files when warmup is disabled", () => {
    const warmupFile = vi.fn().mockResolvedValue(false);
    const state = fakeState({ warmup: false, warmupFile });
    const handler = registerAndGetHandler(() => state);

    handler(readEvent("src/index.ts"), fakeContext());

    expect(warmupFile).not.toHaveBeenCalled();
  });

  it("ignores non-read tool calls", () => {
    const warmupFile = vi.fn().mockResolvedValue(false);
    const state = fakeState({ warmupFile });
    const handler = registerAndGetHandler(() => state);

    handler({ toolName: "bash", input: { command: "pwd" } }, fakeContext());

    expect(warmupFile).not.toHaveBeenCalled();
  });

  it("swallows background warmup failures", async () => {
    const warmupFile = vi.fn().mockRejectedValue(new Error("boom"));
    const state = fakeState({ warmupFile });
    const handler = registerAndGetHandler(() => state);

    expect(() => handler(readEvent("src/index.ts"), fakeContext())).not.toThrow();
    await flushPromises();

    expect(warmupFile).toHaveBeenCalledWith("src/index.ts");
  });
});

function registerAndGetHandler(getState: () => LspExtensionState | null): Handler {
  let handler: Handler | undefined;
  registerLspWarmup(
    {
      on: (_event: string, next: Handler) => {
        handler = next;
      },
    } as never,
    getState,
  );
  if (!handler) throw new Error("tool_call handler was not registered");
  return handler;
}

function fakeState(
  options: {
    warmup?: boolean;
    warmupFile?: (filePath: string) => Promise<boolean>;
    activeClients?: () => Array<{ id: string; serverId: string; rootDir: string }>;
  } = {},
): LspExtensionState {
  return {
    ownerId: "test",
    cwd: "/repo",
    config: {
      catalog: {
        servers: {
          vtsls: {
            id: "vtsls",
            displayName: "VTSLS",
            filetypes: ["typescript"],
            rootMarkers: ["package.json"],
            install: { type: "system", command: ["fake-ls"] },
            command: ["fake-ls"],
            env: {},
            settings: {},
            initializationOptions: {},
            lazy: true,
          },
        },
      },
      warnings: [],
      installMode: "prompt",
      warmup: options.warmup ?? true,
    },
    installManager: {} as never,
    processRegistry: {} as never,
    runtimeManager: {
      warmupFile: options.warmupFile ?? (async () => false),
      activeClients: options.activeClients ?? (() => []),
    } as never,
    resultCache: {} as never,
  };
}

function fakeContext(): FakeContext {
  const statuses: Record<string, string | undefined> = {};
  return {
    ui: {
      statuses,
      theme: { fg: (_name: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) => {
        statuses[key] = value;
      },
    },
  };
}

function readEvent(path: string): { toolName: string; input: Record<string, unknown> } {
  return { toolName: "read", input: { path } };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
