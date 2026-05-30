import { describe, expect, it } from "vitest";
import { formatLspDoctor, formatLspStatus, type LspStatusSnapshot } from "../../src/commands/status.js";
import { LspPanel, type LspPanelAction } from "../../src/ui/lspPanel.js";
import { BUILTIN_CATALOG } from "../../src/registry/builtin.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  fg: (_name: string, text: string) => text,
} as Theme;

describe("LSP status formatting", () => {
  it("summarizes install state and tracked process counts", () => {
    const text = formatLspStatus(snapshot());

    expect(text).toContain("installMode: prompt");
    expect(text).toContain("warmup: enabled");
    expect(text).toContain("tracked processes: 1");
    expect(text).toContain("- pyright: installed, 1 process");
  });

  it("formats per-server doctor details", () => {
    const text = formatLspDoctor(snapshot(), "pyright");

    expect(text).toContain("server: pyright");
    expect(text).toContain("resolvedCommand: /tmp/pyright-langserver --stdio");
    expect(text).toContain("pid 1234");
  });
});

describe("LspPanel", () => {
  it("renders an overlay-friendly server list and emits selected actions", () => {
    const actions: LspPanelAction[] = [];
    const panel = new LspPanel(snapshot(), theme, (action) => actions.push(action));

    expect(panel.render(100).join("\n")).toContain("LSP");

    panel.handleInput("\r");
    expect(actions[0]).toEqual({ type: "doctor", serverId: "gopls" });

    panel.handleInput("i");
    expect(actions[1]).toEqual({ type: "install", serverId: "gopls" });
  });
});

function snapshot(): LspStatusSnapshot {
  return {
    config: {
      catalog: BUILTIN_CATALOG,
      warnings: [],
      installMode: "prompt",
      warmup: true,
    },
    lockfile: {
      servers: {
        pyright: {
          installer: "npm",
          resolvedCommand: ["/tmp/pyright-langserver", "--stdio"],
          installedAt: "2026-05-28T00:00:00.000Z",
        },
      },
    },
    processes: [
      {
        id: "pyright:/repo",
        serverId: "pyright",
        rootDir: "/repo",
        pid: 1234,
        command: ["/tmp/pyright-langserver", "--stdio"],
        cwd: "/repo",
        startedAt: "2026-05-28T00:00:00.000Z",
        ownerId: "owner-a",
        ownerPid: 999,
      },
    ],
  };
}
