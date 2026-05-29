import { describe, expect, it } from "vitest";
import { SymbolKind } from "vscode-languageserver-protocol";
import { registerLspTools } from "../../src/tools/registerLspTools.js";
import {
  failure,
  formatDiagnostics,
  formatReferences,
  formatWorkspaceSymbols,
  toLspPosition,
} from "../../src/tools/lspFormat.js";
import {
  LSP_RESULT_ID_LENGTH,
  LSP_RESULT_ID_PATTERN,
  LspResultCache,
  MAX_LSP_RESULT_CACHE_BYTES,
} from "../../src/tools/resultCache.js";
import type { LspExtensionState } from "../../src/state.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

type Tool = {
  name: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: never) => Promise<ToolResult>;
};

describe("LSP tools", () => {
  it("converts 1-based tool positions to 0-based LSP positions", () => {
    expect(toLspPosition({ line: 7, column: 3 })).toEqual({ line: 6, character: 2 });
    expect(toLspPosition({ line: 0, column: -1 })).toEqual({ line: 0, character: 0 });
  });

  it("passes converted positions to the runtime manager", async () => {
    const calls: Array<{ filePath: string; line: number; character: number }> = [];
    const pi = fakePi();
    registerLspTools(
      pi.api,
      () =>
        ({
          runtimeManager: {
            hover: async (filePath: string, line: number, character: number) => {
              calls.push({ filePath, line, character });
              return {
                serverId: "vtsls",
                rootDir: "/repo",
                filePath,
                uri: "file:///repo/src/index.ts",
                result: { contents: { kind: "markdown", value: "hover text" } },
              };
            },
          },
        }) as LspExtensionState,
    );

    const result = await pi.tools.get("lsp_hover")?.execute("tool-1", {
      filePath: "/repo/src/index.ts",
      line: 10,
      column: 4,
    } as never);

    expect(calls).toEqual([{ filePath: "/repo/src/index.ts", line: 9, character: 3 }]);
    expect(result?.content[0]?.text).toContain("hover text");
  });

  it("returns clear error text when the extension is not initialized", async () => {
    const pi = fakePi();
    registerLspTools(pi.api, () => null);

    const result = await pi.tools.get("lsp_diagnostics")?.execute("tool-1", { filePath: "a.ts" } as never);

    expect(result?.content[0]?.text).toContain("LSP extension is not initialized");
  });

  it("formats diagnostics with 1-based ranges", () => {
    const result = formatDiagnostics({
      serverId: "vtsls",
      rootDir: "/repo",
      filePath: "/repo/src/index.ts",
      uri: "file:///repo/src/index.ts",
      diagnostics: [
        {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
          severity: 1,
          message: "Broken",
          source: "ts",
        },
      ],
    });

    expect(result.content[0].text).toContain("error 3:5 Broken");
  });

  it("keeps expected LSP tool errors concise and guided", () => {
    const noisyPositionError = new Error(
      "Request textDocument/hover failed with message: <semantic> TypeScript Server Error (5.9.3)\n" +
        "Debug Failure. Bad line number. Line: 9998, lineStarts.length: 163\n" +
        "Error: Debug Failure\n    at computePositionOfLineAndCharacter",
    );

    const positionResult = failure("lsp_hover", noisyPositionError);
    expect(positionResult.content[0].text).toContain("Position is outside the file");
    expect(positionResult.content[0].text).toContain("identifier token");
    expect(positionResult.content[0].text).not.toContain("computePositionOfLineAndCharacter");

    const missingFileResult = failure(
      "lsp_hover",
      new Error("ENOENT: no such file or directory, open '/repo/src/missing.ts'"),
    );
    expect(missingFileResult.content[0].text).toContain("File not found: /repo/src/missing.ts");
    expect(missingFileResult.content[0].text).toContain("Check filePath");
  });

  it("returns cached LSP result pages sequentially", () => {
    const cache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
    const resultId = cache.store({
      label: "references",
      pages: [
        {
          text: "page 1",
          details: { ok: true, page: { start: 1, end: 1, total: 2 }, items: ["a"] },
        },
        {
          text: "page 2",
          details: { ok: true, page: { start: 2, end: 2, total: 2 }, items: ["b"] },
        },
      ],
    });

    expect(resultId).toBeDefined();
    expect(cache.next(resultId!).content[0]?.text).toBe("page 2");
    expect(cache.next(resultId!).content[0]?.text).toContain("No more cached LSP pages");
  });

  it("evicts cached LSP result pages to stay under the byte cap", () => {
    const cache = new LspResultCache({ maxBytes: 800, ttlMs: 60_000, maxEntries: 10 });
    const first = cache.store({
      label: "first",
      pages: [
        { text: "first page", details: { payload: "x".repeat(300) } },
        { text: "first page 2", details: { payload: "x".repeat(300) } },
      ],
    });
    const second = cache.store({
      label: "second",
      pages: [
        { text: "second page", details: { payload: "y".repeat(300) } },
        { text: "second page 2", details: { payload: "y".repeat(300) } },
      ],
    });

    expect(cache.stats().bytes).toBeLessThanOrEqual(800);
    expect(cache.next(first!).content[0]?.text).toContain("Cached LSP result not found");
    expect(cache.next(second!).content[0]?.text).toBe("second page 2");
  });

  it("uses a 64 MB default LSP result cache budget", () => {
    expect(MAX_LSP_RESULT_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("registers lsp_more and returns cached pages", async () => {
    const pi = fakePi();
    const resultCache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
    const resultId = resultCache.store({
      label: "references",
      pages: [
        { text: "page 1", details: { page: 1 } },
        { text: "page 2", details: { page: 2 } },
      ],
    });

    registerLspTools(
      pi.api,
      () =>
        ({
          resultCache,
        }) as LspExtensionState,
    );

    const result = await pi.tools.get("lsp_more")?.execute("tool-1", { resultId } as never);
    expect(result?.content[0]?.text).toBe("page 2");
    expect(result?.details).toEqual({ page: 2 });
  });

  it("validates lsp_more resultId shape and steers paginated use", async () => {
    const pi = fakePi();
    const resultCache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });

    registerLspTools(
      pi.api,
      () =>
        ({
          resultCache,
        }) as LspExtensionState,
    );

    const tool = pi.tools.get("lsp_more");
    const resultIdSchema = (tool?.parameters as { properties: { resultId: Record<string, unknown> } }).properties
      .resultId;

    expect(resultIdSchema.pattern).toBe(LSP_RESULT_ID_PATTERN);
    expect(resultIdSchema.minLength).toBe(LSP_RESULT_ID_LENGTH);
    expect(resultIdSchema.maxLength).toBe(LSP_RESULT_ID_LENGTH);
    expect(tool?.promptGuidelines?.join(" ")).toContain("More available");

    const result = await tool?.execute("tool-1", { resultId: "not-a-real-id" } as never);
    expect(result?.content[0]?.text).toContain("Invalid LSP resultId format");
    expect(result?.details).toEqual({ ok: false, error: "invalid-result-id" });
  });

  it("ranks diagnostics by severity and paginates details", () => {
    const cache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
    const result = formatDiagnostics(
      {
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        diagnostics: [
          {
            range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
            severity: 2,
            message: "Warning later",
            source: "ts",
          },
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
            severity: 1,
            message: "Error first",
            source: "ts",
          },
        ],
      },
      cache,
      { pageSize: 1 },
    );

    expect(result.content[0].text).toContain("error 3:5 Error first");
    expect(result.content[0].text).toContain("Showing 1-1 of 2");
    expect(JSON.stringify(result.details)).toContain("Error first");
    expect(JSON.stringify(result.details)).not.toContain("Warning later");
    expect(result.content[0].text).toMatch(/resultId: lspres_/u);
  });

  it("paginates references and keeps details lean", () => {
    const cache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
    const result = formatReferences(
      {
        serverId: "vtsls",
        rootDir: "/repo",
        filePath: "/repo/src/index.ts",
        uri: "file:///repo/src/index.ts",
        result: [
          {
            uri: "file:///repo/src/index.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          {
            uri: "file:///repo/src/other.ts",
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } },
          },
        ],
      },
      cache,
      { pageSize: 1 },
    );

    expect(result.content[0].text).toContain("Showing 1-1 of 2");
    expect(JSON.stringify(result.details)).toContain("index.ts");
    expect(JSON.stringify(result.details)).not.toContain("other.ts");
  });

  it("ranks workspace symbols by exact and prefix matches before broad matches", () => {
    const cache = new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
    const result = formatWorkspaceSymbols(
      [
        {
          serverId: "vtsls",
          rootDir: "/repo",
          result: [
            {
              name: "SomeLspRuntimeManagerHelper",
              kind: SymbolKind.Function,
              location: {
                uri: "file:///repo/src/helper.ts",
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              },
            },
            {
              name: "LspRuntimeManager",
              kind: SymbolKind.Class,
              location: {
                uri: "file:///repo/src/runtime.ts",
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
              },
            },
          ],
        },
      ],
      cache,
      { query: "LspRuntimeManager", pageSize: 1 },
    );

    expect(result.content[0].text).toContain("LspRuntimeManager");
    expect(result.content[0].text).not.toContain("SomeLspRuntimeManagerHelper");
  });
});

function fakePi(): { api: never; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  return {
    tools,
    api: {
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    } as never,
  };
}
