import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { LspExtensionState } from "./state.js";

interface StatusLineContext {
  ui: {
    theme: { fg: (name: ThemeColor, text: string) => string };
    setStatus: (key: string, value: string | undefined) => void;
  };
}

export function formatLspStatusLine(state: LspExtensionState): string {
  const active = new Set(state.runtimeManager.activeClients().map((client) => client.serverId)).size;
  const total = Object.keys(state.config.catalog.servers).length;
  const warnings = state.config.warnings.length;
  return `LSP: ${active}/${total} servers${warnings > 0 ? `, ${warnings} warning(s)` : ""}`;
}

export function setLspStatusLine(ctx: StatusLineContext, state: LspExtensionState): void {
  const color: ThemeColor = state.config.warnings.length > 0 ? "warning" : "accent";
  ctx.ui.setStatus("lsp", ctx.ui.theme.fg(color, formatLspStatusLine(state)));
}
