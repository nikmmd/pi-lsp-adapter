import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLspCommand } from "../../src/commands/registerCommands.js";
import type { LspExtensionState } from "../../src/state.js";

type Handler = (args: string, ctx: FakeCommandContext) => Promise<void> | void;

interface FakeCommandContext {
  hasUI: boolean;
  ui: {
    notifications: Array<{ message: string; level: string }>;
    statuses: Record<string, string | undefined>;
    theme: { fg: (name: string, text: string) => string };
    notify: (message: string, level: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    custom: <T>(fn: () => { render: () => string[] }) => Promise<T | undefined>;
  };
}

let tempHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-commands-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

function fakeContext(): FakeCommandContext {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Record<string, string | undefined> = {};
  return {
    hasUI: true,
    ui: {
      notifications,
      statuses,
      theme: { fg: (_name: string, text: string) => text },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => { statuses[key] = value; },
      custom: async () => undefined,
    },
  };
}

function fakeNoUIContext(): FakeCommandContext {
  return {
    ...fakeContext(),
    hasUI: false,
  };
}

function fakeState(partial?: Partial<LspExtensionState>): LspExtensionState {
  return {
    ownerId: "test-owner",
    cwd: tempHome,
    config: { catalog: { servers: {} }, warnings: [], installMode: "auto" },
    installManager: {
      ensureInstalled: async () => ({ status: "installed", serverId: "vtsls" }),
      installServer: async (id: string) => ({
        serverId: id,
        metadata: { installer: "npm" as const, resolvedCommand: [id], installedAt: new Date().toISOString() },
      }),
      updateServer: async (id: string) => ({
        serverId: id,
        metadata: { installer: "npm" as const, resolvedCommand: [id], installedAt: new Date().toISOString() },
      }),
      uninstallServer: async (id: string) => ({ serverId: id, removed: true }),
    } as any,
    processRegistry: {
      list: async () => [],
      terminateProcesses: async () => ({ terminated: [], removed: [], kept: [] }),
    } as any,
    runtimeManager: {
      startServer: async () => [],
      restartServer: async () => [],
      stopServer: async () => 0,
      activeClients: () => [],
    } as any,
    resultCache: {} as any,
    ...partial,
  };
}

describe("registerLspCommand", () => {
  it("shows error when extension is not initialized", async () => {
    const ctx = fakeContext();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => null,
    );
    await handler!("status", ctx);
    expect(ctx.ui.notifications[0]).toEqual({ message: "LSP extension is not initialized.", level: "error" });
  });

  it("does not crash when hasUI is false (notify is skipped)", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeNoUIContext();
    await expect(handler!("status", ctx)).resolves.not.toThrow();
  });

  it("shows text status when forceText is true", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("status", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("LSP status");
  });

  it("shows doctor output with status summary", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("doctor", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Run /lsp doctor <serverId>");
  });

  it("shows doctor output for a specific server", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("doctor pyright", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Unknown LSP server: pyright");
  });

  it("shows error for unknown subcommand", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("unknown", ctx);
    expect(ctx.ui.notifications[0]).toEqual({ message: "Unknown /lsp subcommand: unknown", level: "error" });
  });

  it("delegates to install subcommand", async () => {
    const installSpy = vi.fn().mockResolvedValue({
      serverId: "vtsls",
      metadata: { installer: "npm" as const, resolvedCommand: ["vtsls"], installedAt: new Date().toISOString() },
    });
    const state = fakeState({
      installManager: {
        ...fakeState().installManager,
        installServer: installSpy,
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("install vtsls", ctx);
    expect(installSpy).toHaveBeenCalledWith("vtsls", undefined);
    expect(ctx.ui.notifications[0]?.message).toContain("Installed vtsls");
  });

  it("shows usage error for install without server id", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("install", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "Usage: /lsp install <serverId[@version]>",
      level: "error",
    });
  });

  it("delegates to update subcommand", async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      serverId: "pyright",
      metadata: { installer: "npm" as const, resolvedCommand: ["pyright"], installedAt: new Date().toISOString() },
    });
    const state = fakeState({
      installManager: {
        ...fakeState().installManager,
        updateServer: updateSpy,
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("update pyright@1.1.406", ctx);
    expect(updateSpy).toHaveBeenCalledWith("pyright", "1.1.406");
  });

  it("delegates to update --all subcommand", async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      serverId: "pyright",
      metadata: { installer: "npm" as const, resolvedCommand: ["pyright"], installedAt: new Date().toISOString() },
    });
    const state = fakeState({
      config: {
        catalog: {
          servers: {
            pyright: { id: "pyright", displayName: "Pyright", filetypes: ["python"], rootMarkers: ["pyproject.toml"], install: { type: "system", command: ["pyright"] }, command: ["pyright"], env: {}, settings: {}, initializationOptions: {}, lazy: true },
          },
        },
        warnings: [],
        installMode: "auto",
      },
      installManager: {
        ...fakeState().installManager,
        updateServer: updateSpy,
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("update --all", ctx);
    expect(updateSpy).toHaveBeenCalledWith("pyright");
    expect(ctx.ui.notifications[0]?.message).toContain("Updated all configured LSP servers");
  });

  it("delegates to update --all subcommand", async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      serverId: "pyright",
      metadata: { installer: "npm" as const, resolvedCommand: ["pyright"], installedAt: new Date().toISOString() },
    });
    const state = fakeState({
      config: {
        catalog: {
          servers: {
            pyright: { id: "pyright", displayName: "Pyright", filetypes: ["python"], rootMarkers: ["pyproject.toml"], install: { type: "system", command: ["pyright"] }, command: ["pyright"], env: {}, settings: {}, initializationOptions: {}, lazy: true },
          },
        },
        warnings: [],
        installMode: "auto",
      },
      installManager: {
        ...fakeState().installManager,
        updateServer: updateSpy,
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("update --all", ctx);
    expect(updateSpy).toHaveBeenCalledWith("pyright");
    expect(ctx.ui.notifications[0]?.message).toContain("Updated all configured LSP servers");
  });

  it("shows usage error for update without server id", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("update", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "Usage: /lsp update <serverId[@version]> or /lsp update --all",
      level: "error",
    });
  });

  it("delegates to uninstall subcommand", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        stopServer: vi.fn().mockResolvedValue(1),
      },
      processRegistry: {
        ...fakeState().processRegistry,
        terminateProcesses: vi.fn().mockResolvedValue({ terminated: [], removed: [{ id: "x" }] }),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("uninstall pyright", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Uninstalled pyright");
  });

  it("shows usage error for uninstall without server id", async () => {
    const state = fakeState();
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("uninstall", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "Usage: /lsp uninstall <serverId>",
      level: "error",
    });
  });

  it("delegates to stop subcommand", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        stopServer: vi.fn().mockResolvedValue(2),
      },
      processRegistry: {
        ...fakeState().processRegistry,
        terminateProcesses: vi.fn().mockResolvedValue({ terminated: [], removed: [] }),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("stop pyright", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Stopped 2 tracked LSP process(es) for pyright");
  });

  it("delegates to start subcommand", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        startServer: vi.fn().mockResolvedValue([
          { status: "running", message: "Started vtsls" },
        ]),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("start vtsls", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Started vtsls");
  });

  it("delegates to restart subcommand", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        restartServer: vi.fn().mockResolvedValue([
          { status: "running", message: "Restarted vtsls" },
        ]),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("restart vtsls", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Restarted vtsls");
  });

  it("handles startServer with missing server gracefully", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        startServer: vi.fn().mockResolvedValue([]),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("start vtsls", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("No installed LSP servers to start");
  });

  it("wraps thrown errors in the handler", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        startServer: vi.fn().mockRejectedValue(new Error("boom")),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("start", ctx);
    expect(ctx.ui.notifications[0]).toEqual({ message: "boom", level: "error" });
  });

  it("handles non-Error throws in the handler", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        startServer: vi.fn().mockRejectedValue("string error"),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("start", ctx);
    expect(ctx.ui.notifications[0]).toEqual({ message: "string error", level: "error" });
  });

  it("updates status line after operations", async () => {
    const state = fakeState({
      runtimeManager: {
        ...fakeState().runtimeManager,
        stopServer: vi.fn().mockResolvedValue(0),
      },
      processRegistry: {
        ...fakeState().processRegistry,
        terminateProcesses: vi.fn().mockResolvedValue({ terminated: [], removed: [] }),
      },
    });
    let handler: Handler | undefined;
    registerLspCommand(
      { registerCommand: (_name: string, cmd: { handler: Handler }) => { handler = cmd.handler; } } as any,
      () => state,
    );
    const ctx = fakeContext();
    await handler!("stop", ctx);
    expect(ctx.ui.statuses.lsp).toBeDefined();
  });
});
