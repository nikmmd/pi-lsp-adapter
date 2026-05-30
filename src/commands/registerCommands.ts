import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readLockfile } from "../install/lockfile.js";
import { parseServerVersionSpec } from "../install/version.js";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";
import { LspPanel, type LspPanelAction } from "../ui/lspPanel.js";
import { formatLspDoctor, formatLspStatus, type LspStatusSnapshot } from "./status.js";

export type GetLspState = () => LspExtensionState | null;

export function registerLspCommand(pi: ExtensionAPI, getState: GetLspState): void {
  pi.registerCommand("lsp", {
    description: "Show and manage LSP server status",
    handler: async (args, ctx) => {
      const state = getState();
      if (!state) {
        notify(ctx, "LSP extension is not initialized.", "error");
        return;
      }

      const parts = args.trim().split(/\s+/u).filter(Boolean);
      const subcommand = parts[0] ?? "";

      try {
        switch (subcommand) {
          case "":
          case "status":
            await showStatusOrPanel(state, ctx, subcommand === "status");
            return;
          case "doctor":
            await showDoctor(state, ctx, parts[1]);
            return;
          case "install":
            await installServer(state, ctx, parts[1]);
            return;
          case "update":
            await updateServer(state, ctx, parts[1]);
            return;
          case "uninstall":
            await uninstallServer(state, ctx, parts[1]);
            return;
          case "stop":
            await stopProcesses(state, ctx, parts[1]);
            return;
          case "start":
            await startServers(state, ctx, parts[1]);
            return;
          case "restart":
            await restartServers(state, ctx, parts[1]);
            return;
          default:
            notify(ctx, `Unknown /lsp subcommand: ${subcommand}`, "error");
        }
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

async function showStatusOrPanel(
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
  forceText: boolean,
): Promise<void> {
  const snapshot = await buildSnapshot(state);
  if (!ctx.hasUI || forceText) {
    notify(ctx, formatLspStatus(snapshot), "info");
    return;
  }

  const action = await ctx.ui.custom<LspPanelAction>(
    (tui, theme, _keybindings, done) => {
      const panel = new LspPanel(snapshot, theme, done);
      return {
        render: (width: number) => panel.render(width),
        invalidate: () => panel.invalidate(),
        handleInput: (data: string) => {
          panel.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: 92 } },
  );

  await handlePanelAction(action, state, ctx);
}

async function handlePanelAction(
  action: LspPanelAction | undefined,
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!action || action.type === "close") return;
  switch (action.type) {
    case "doctor":
      await showDoctor(state, ctx, action.serverId);
      return;
    case "install":
      await installServer(state, ctx, action.serverId);
      return;
    case "update":
      await updateServer(state, ctx, action.serverId);
      return;
    case "uninstall":
      await uninstallServer(state, ctx, action.serverId);
      return;
    case "stop":
      await stopProcesses(state, ctx, action.serverId);
      return;
    case "refresh":
      await showStatusOrPanel(state, ctx, false);
  }
}

async function showDoctor(state: LspExtensionState, ctx: ExtensionCommandContext, serverId?: string): Promise<void> {
  notify(ctx, formatLspDoctor(await buildSnapshot(state), serverId), "info");
}

async function installServer(
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
  spec: string | undefined,
): Promise<void> {
  if (!spec) {
    notify(ctx, "Usage: /lsp install <serverId[@version]>", "error");
    return;
  }
  const { serverId, version } = parseServerVersionSpec(spec);
  const result = await state.installManager.installServer(serverId, version);
  notify(ctx, `Installed ${result.serverId}: ${result.metadata.resolvedCommand.join(" ")}`, "info");
}

async function updateServer(
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
  spec: string | undefined,
): Promise<void> {
  if (!spec) {
    notify(ctx, "Usage: /lsp update <serverId[@version]> or /lsp update --all", "error");
    return;
  }

  if (spec === "--all") {
    for (const serverId of Object.keys(state.config.catalog.servers)) {
      await state.installManager.updateServer(serverId);
    }
    notify(ctx, "Updated all configured LSP servers.", "info");
    return;
  }

  const { serverId, version } = parseServerVersionSpec(spec);
  const result = await state.installManager.updateServer(serverId, version);
  notify(ctx, `Updated ${result.serverId}: ${result.metadata.resolvedCommand.join(" ")}`, "info");
}

async function uninstallServer(
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
  serverId: string | undefined,
): Promise<void> {
  if (!serverId) {
    notify(ctx, "Usage: /lsp uninstall <serverId>", "error");
    return;
  }

  const runtimeStopped = await state.runtimeManager.stopServer(serverId);
  const stopped = runtimeStopped + (await terminateMatchingProcesses(state, serverId));
  const result = await state.installManager.uninstallServer(serverId);
  setLspStatusLine(ctx, state);
  notify(
    ctx,
    `${result.removed ? "Uninstalled" : "No install found for"} ${serverId}; stopped ${stopped} process(es).`,
    "info",
  );
}

async function startServers(state: LspExtensionState, ctx: ExtensionCommandContext, serverId?: string): Promise<void> {
  const results = await state.runtimeManager.startServer(serverId, { allowPromptInstall: true });
  setLspStatusLine(ctx, state);
  notify(ctx, formatStartResults("start", results), hasStartErrors(results) ? "warning" : "info");
}

async function restartServers(
  state: LspExtensionState,
  ctx: ExtensionCommandContext,
  serverId?: string,
): Promise<void> {
  const results = await state.runtimeManager.restartServer(serverId, { allowPromptInstall: true });
  setLspStatusLine(ctx, state);
  notify(ctx, formatStartResults("restart", results), hasStartErrors(results) ? "warning" : "info");
}

async function stopProcesses(state: LspExtensionState, ctx: ExtensionCommandContext, serverId?: string): Promise<void> {
  const runtimeStopped = await state.runtimeManager.stopServer(serverId);
  const stopped = runtimeStopped + (await terminateMatchingProcesses(state, serverId));
  setLspStatusLine(ctx, state);
  notify(ctx, `Stopped ${stopped} tracked LSP process(es)${serverId ? ` for ${serverId}` : ""}.`, "info");
}

async function terminateMatchingProcesses(state: LspExtensionState, serverId?: string): Promise<number> {
  const result = await state.processRegistry.terminateProcesses((entry) => !serverId || entry.serverId === serverId);
  return result.terminated.length + result.removed.length;
}

async function buildSnapshot(state: LspExtensionState): Promise<LspStatusSnapshot> {
  return {
    config: state.config,
    lockfile: await readLockfile(),
    processes: await state.processRegistry.list(),
  };
}

function formatStartResults(action: "start" | "restart", results: Array<{ status: string; message: string }>): string {
  if (results.length === 0) return `No installed LSP servers to ${action}. Run /lsp install <serverId> first.`;
  return results.map((result) => result.message).join("\n");
}

function hasStartErrors(results: Array<{ status: string }>): boolean {
  return results.some(
    (result) => result.status === "missing" || result.status === "declined" || result.status === "error",
  );
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
