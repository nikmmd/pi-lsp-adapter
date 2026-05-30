import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LspStatusSnapshot } from "../commands/status.js";

export type LspPanelAction =
  | { type: "doctor"; serverId: string }
  | { type: "install"; serverId: string }
  | { type: "update"; serverId: string }
  | { type: "uninstall"; serverId: string }
  | { type: "stop"; serverId?: string }
  | { type: "refresh" }
  | { type: "close" };

export class LspPanel {
  private selected = 0;
  private readonly serverIds: string[];

  constructor(
    private readonly snapshot: LspStatusSnapshot,
    private readonly theme: Theme,
    private readonly done: (action: LspPanelAction) => void,
  ) {
    this.serverIds = Object.keys(snapshot.config.catalog.servers).sort();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done({ type: "close" });
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }

    if (matchesKey(data, "down")) {
      this.selected = Math.min(Math.max(0, this.serverIds.length - 1), this.selected + 1);
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      this.withSelectedServer((serverId) => this.done({ type: "doctor", serverId }));
      return;
    }

    if (data === "i") this.withSelectedServer((serverId) => this.done({ type: "install", serverId }));
    if (data === "u") this.withSelectedServer((serverId) => this.done({ type: "update", serverId }));
    if (data === "x") this.withSelectedServer((serverId) => this.done({ type: "uninstall", serverId }));
    if (data === "s") this.withSelectedServer((serverId) => this.done({ type: "stop", serverId }));
    if (data === "S") this.done({ type: "stop" });
    if (data === "r") this.done({ type: "refresh" });
  }

  render(width: number): string[] {
    const panelWidth = Math.min(Math.max(60, width), 100);
    const innerWidth = panelWidth - 2;
    const lines: string[] = [];
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content = "") => border("│") + padVisible(` ${content}`, innerWidth) + border("│");

    lines.push(border(`╭${centerTitle(" LSP ", innerWidth)}╮`));
    lines.push(
      row(
        `installMode: ${this.snapshot.config.installMode}  warmup: ${this.snapshot.config.warmup ? "on" : "off"}  tracked pids: ${this.snapshot.processes.length}`,
      ),
    );

    if (this.snapshot.config.warnings.length > 0) {
      lines.push(row(this.theme.fg("warning", `${this.snapshot.config.warnings.length} config warning(s)`)));
    }

    lines.push(border(`├${"─".repeat(innerWidth)}┤`));

    if (this.serverIds.length === 0) {
      lines.push(row(this.theme.fg("dim", "No LSP servers configured")));
    } else {
      for (const [index, serverId] of this.serverIds.entries()) {
        const server = this.snapshot.config.catalog.servers[serverId]!;
        const installed = this.snapshot.lockfile.servers[serverId]
          ? this.theme.fg("success", "installed")
          : this.theme.fg("warning", "missing");
        const pidCount = this.snapshot.processes.filter((process) => process.serverId === serverId).length;
        const pointer = index === this.selected ? this.theme.fg("accent", "▶") : " ";
        const label = index === this.selected ? this.theme.fg("accent", serverId) : serverId;
        lines.push(
          row(`${pointer} ${label} ${this.theme.fg("dim", server.displayName)} ${installed} pids:${pidCount}`),
        );
      }
    }

    lines.push(border(`├${"─".repeat(innerWidth)}┤`));
    lines.push(
      row(
        this.theme.fg(
          "dim",
          "↑↓ select • enter doctor • i install • u update • x uninstall • s stop • r refresh • esc close",
        ),
      ),
    );
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private withSelectedServer(callback: (serverId: string) => void): void {
    const serverId = this.serverIds[this.selected];
    if (serverId) callback(serverId);
  }
}

function centerTitle(title: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(title)) / 2));
  const right = Math.max(0, width - visibleWidth(title) - left);
  return `${"─".repeat(left)}${title}${"─".repeat(right)}`;
}

function padVisible(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}
