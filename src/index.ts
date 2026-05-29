import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLspConfig } from "./config/loadConfig.js";
import { LspInstallManager } from "./install/manager.js";
import { ensureManagedLspRoot } from "./install/lockfile.js";
import { LspProcessRegistry } from "./lsp/processRegistry.js";
import { LspRuntimeManager } from "./lsp/runtimeManager.js";
import { registerLspCommand } from "./commands/registerCommands.js";
import { registerLspTools } from "./tools/registerLspTools.js";
import { LspResultCache } from "./tools/resultCache.js";
import { setLspStatusLine } from "./statusLine.js";
import type { LspExtensionState } from "./state.js";

export default function piAgentLspExtension(pi: ExtensionAPI): void {
  let state: LspExtensionState | null = null;
  let generation = 0;

  registerLspCommand(pi, () => state);
  registerLspTools(pi, () => state);

  pi.on("before_agent_start", (event) => {
    if (!state) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nLSP integration: read-only LSP tools are available for diagnostics, hover/type info, definitions, references, document symbols, and workspace symbol search. Prefer these tools when semantic code understanding would reduce guesswork; they use 1-based line/column inputs and do not mutate files. For hover, definition, and references, place the column on the identifier token itself. When an LSP result says "More available" and includes a resultId, use lsp_more only if you need the next sequential page; re-run the original LSP query if the resultId is missing or expired.`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const currentGeneration = ++generation;
    const previousState = state;
    state = null;

    await shutdownState(previousState, ctx, "session_restart");
    if (currentGeneration !== generation) return;

    const ownerId = createOwnerId();
    try {
      await ensureManagedLspRoot();
      const config = await loadLspConfig({ cwd: ctx.cwd, projectRoot: ctx.cwd });
      const processRegistry = new LspProcessRegistry({ ownerId });
      const recovery = await processRegistry.cleanupStaleProcesses();
      const installManager = new LspInstallManager({
        catalog: config.catalog,
        installMode: config.installMode,
        confirmer: ctx.hasUI
          ? async ({ server, command }) => ctx.ui.confirm(`Install ${server.displayName}?`, `Run ${command}?`)
          : undefined,
      });
      const runtimeManager = new LspRuntimeManager({
        cwd: ctx.cwd,
        ownerId,
        config,
        installManager,
        processRegistry,
      });
      const resultCache = new LspResultCache();

      const nextState: LspExtensionState = {
        ownerId,
        cwd: ctx.cwd,
        config,
        installManager,
        processRegistry,
        runtimeManager,
        resultCache,
        lastRecovery: {
          terminated: recovery.terminated.length,
          removed: recovery.removed.length,
          kept: recovery.kept.length,
        },
      };

      if (currentGeneration !== generation) {
        await shutdownState(nextState, ctx, "stale_session_start");
        return;
      }

      state = nextState;
      setLspStatusLine(ctx, nextState);
      notifyStartup(ctx, nextState);
    } catch (error) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("error", "LSP: failed"));
      if (ctx.hasUI) ctx.ui.notify(`LSP initialization failed: ${messageFromError(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ++generation;
    const currentState = state;
    state = null;
    await shutdownState(currentState, ctx, "session_shutdown");
  });
}

async function shutdownState(
  state: LspExtensionState | null,
  ctx: ExtensionContext,
  _reason: "session_restart" | "session_shutdown" | "stale_session_start",
): Promise<void> {
  if (!state) return;

  try {
    state.resultCache.clear();
    await state.runtimeManager.shutdown();
    const result = await state.processRegistry.terminateOwnedProcesses();
    if (ctx.hasUI && result.terminated.length > 0) {
      ctx.ui.notify(`LSP: stopped ${result.terminated.length} process(es).`, "info");
    }
  } catch (error) {
    if (ctx.hasUI) ctx.ui.notify(`LSP shutdown cleanup failed: ${messageFromError(error)}`, "error");
  } finally {
    ctx.ui.setStatus("lsp", undefined);
  }
}

function notifyStartup(ctx: ExtensionContext, state: LspExtensionState): void {
  if (!ctx.hasUI) return;
  const recovery = state.lastRecovery;
  if (recovery && recovery.terminated + recovery.removed > 0) {
    ctx.ui.notify(
      `LSP recovered ${recovery.terminated + recovery.removed} stale pid entr${recovery.terminated + recovery.removed === 1 ? "y" : "ies"}.`,
      "info",
    );
  }
}

function createOwnerId(): string {
  return `pi-lsp-${process.pid}-${randomUUID()}`;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
