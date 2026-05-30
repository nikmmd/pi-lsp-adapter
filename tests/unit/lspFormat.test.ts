import { describe, expect, it } from "vitest";
import { SymbolKind } from "vscode-languageserver-protocol";
import { formatDefinition, formatDocumentSymbols, formatHover, failure, success } from "../../src/tools/lspFormat.js";
import { LspResultCache } from "../../src/tools/resultCache.js";

function cache(): LspResultCache {
  return new LspResultCache({ maxBytes: 10_000, ttlMs: 60_000, maxEntries: 10 });
}

function baseResult(overrides = {}) {
  return {
    serverId: "vtsls",
    rootDir: "/repo",
    filePath: "/repo/src/index.ts",
    uri: "file:///repo/src/index.ts",
    ...overrides,
  };
}

describe("formatHover", () => {
  it("formats plain text hover", () => {
    const result = formatHover({
      ...baseResult(),
      result: { contents: "simple text" },
    });
    expect(result.content[0].text).toContain("simple text");
  });

  it("formats markdown hover with range", () => {
    const result = formatHover({
      ...baseResult(),
      result: {
        contents: { kind: "markdown", value: "**bold**" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
    });
    expect(result.content[0].text).toContain("**bold**");
    expect(result.details).toHaveProperty("range");
  });

  it("handles null hover result", () => {
    const result = formatHover({
      ...baseResult(),
      result: null,
    });
    expect(result.content[0].text).toContain("No LSP hover result");
  });

  it("formats language block hover", () => {
    const result = formatHover({
      ...baseResult(),
      result: {
        contents: { language: "typescript", value: "const x: number" },
      },
    });
    expect(result.content[0].text).toContain("```typescript");
    expect(result.content[0].text).toContain("const x: number");
  });

  it("formats array of mixed content", () => {
    const result = formatHover({
      ...baseResult(),
      result: {
        contents: ["first part", { language: "markdown", value: "second part" }],
      },
    });
    expect(result.content[0].text).toContain("first part");
    expect(result.content[0].text).toContain("second part");
  });
});

describe("formatDefinition", () => {
  it("formats Location definition result", () => {
    const result = formatDefinition(
      {
        ...baseResult(),
        result: [
          {
            uri: "file:///repo/src/def.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
        ],
      },
      cache(),
    );
    expect(result.content[0].text).toContain("LSP definition");
    expect(result.content[0].text).toContain("def.ts");
  });

  it("formats LocationLink definition result", () => {
    const result = formatDefinition(
      {
        ...baseResult(),
        result: [
          {
            targetUri: "file:///repo/src/def.ts",
            targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          },
        ],
      },
      cache(),
    );
    expect(result.content[0].text).toContain("def.ts");
  });

  it("handles null definition result", () => {
    const result = formatDefinition(
      {
        ...baseResult(),
        result: null,
      },
      cache(),
    );
    expect(result.content[0].text).toContain("No LSP definition locations");
  });

  it("ranks same-file definitions first", () => {
    const result = formatDefinition(
      {
        ...baseResult(),
        result: [
          {
            uri: "file:///repo/src/other.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          {
            uri: "file:///repo/src/index.ts",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      },
      cache(),
    );
    const text = result.content[0].text;
    const sameFileIndex = text.indexOf("index.ts");
    const otherFileIndex = text.indexOf("other.ts");
    expect(sameFileIndex).toBeLessThan(otherFileIndex);
  });
});

describe("formatDocumentSymbols", () => {
  it("formats DocumentSymbol hierarchy with indentation", () => {
    const result = formatDocumentSymbols(
      {
        ...baseResult(),
        result: [
          {
            name: "MyClass",
            kind: SymbolKind.Class,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 12 } },
            children: [
              {
                name: "myMethod",
                kind: SymbolKind.Method,
                range: { start: { line: 1, character: 0 }, end: { line: 5, character: 0 } },
                selectionRange: { start: { line: 1, character: 8 }, end: { line: 1, character: 16 } },
                children: [],
              },
            ],
          },
        ],
      },
      cache(),
    );
    expect(result.content[0].text).toContain("MyClass (class)");
    expect(result.content[0].text).toContain("myMethod (method)");
    // Children should be indented
    expect(result.content[0].text).toContain("  - myMethod");
  });

  it("formats SymbolInformation flat list", () => {
    const result = formatDocumentSymbols(
      {
        ...baseResult(),
        result: [
          {
            name: "standaloneFunc",
            kind: SymbolKind.Function,
            location: {
              uri: "file:///repo/src/index.ts",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
            },
          },
        ],
      },
      cache(),
    );
    expect(result.content[0].text).toContain("standaloneFunc (function)");
  });

  it("handles null document symbols result", () => {
    const result = formatDocumentSymbols(
      {
        ...baseResult(),
        result: null,
      },
      cache(),
    );
    expect(result.content[0].text).toContain("No LSP document symbols");
  });
});

describe("success and failure formatting", () => {
  it("returns structured success result", () => {
    const result = success("text", { ok: true });
    expect(result.content[0].text).toBe("text");
    expect(result.details).toEqual({ ok: true });
  });

  it("failure returns concise ENOENT message", () => {
    const err = new Error("ENOENT: no such file or directory, open '/repo/missing.ts'");
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("File not found: /repo/missing.ts");
  });

  it("failure returns concise position-out-of-bounds message", () => {
    const err = new Error(
      "Request textDocument/hover failed with message: <semantic> TypeScript Server Error (5.9.3)\n" +
        "Debug Failure. Bad line number. Line: 9998, lineStarts.length: 163",
    );
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("Position is outside the file");
  });

  it("failure returns concise timeout message", () => {
    const err = new Error("vtsls textDocument/hover timed out after 10000ms.");
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("timed out");
    expect(result.content[0].text).toContain("Retry the request");
  });

  it("failure returns concise unsupported capability message", () => {
    const err = new Error("vtsls does not support LSP hover.");
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("does not support LSP");
    expect(result.content[0].text).toContain("Try a different LSP tool");
  });

  it("failure returns concise outside workspace message", () => {
    const err = new Error("/outside is outside workspace.");
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("outside workspace");
  });

  it("failure strips trailing period from first line", () => {
    const err = new Error("Request failed.\nMore details");
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("Request failed");
    expect(result.content[0].text).not.toMatch(/Request failed\.$/);
  });

  it("failure handles multi-line request errors", () => {
    const err = new Error(
      "Request textDocument/hover failed with message: Some error\n" +
        "  at stack trace line 1\n" +
        "  at stack trace line 2",
    );
    const result = failure("lsp_hover", err);
    expect(result.content[0].text).toContain("Request textDocument/hover failed with message");
    expect(result.content[0].text).not.toContain("stack trace");
  });
});
