import { describe, expect, it } from "vitest";
import { detectFiletype } from "../../src/detect/filetypes.js";

describe("detectFiletype", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["src/app.tsx", "typescriptreact"],
    ["src/app.js", "javascript"],
    ["src/app.jsx", "javascriptreact"],
    ["main.py", "python"],
    ["cmd/server.go", "go"],
    ["lib.rs", "rust"],
    ["config.yaml", "yaml"],
    ["config.yml", "yaml"],
    ["package.json", "json"],
    ["settings.jsonc", "jsonc"],
    ["Main.java", "java"],
  ])("maps %s to %s", (path, expected) => {
    expect(detectFiletype({ path })).toBe(expected);
  });

  it("applies project overrides before built-ins", () => {
    expect(detectFiletype({ path: "schema.foo", overrides: { extensions: { ".foo": "json" } } })).toBe("json");
  });

  it("normalizes leading @ in paths", () => {
    expect(detectFiletype({ path: "@src/app.ts" })).toBe("typescript");
  });

  it("does not execute user-provided regex or glob path patterns", () => {
    const unsupportedPatternOverride = {
      pathPatterns: { "/.*/": "python", "**/*.unknown": "rust" },
    } as unknown as Parameters<typeof detectFiletype>[0]["overrides"];

    expect(detectFiletype({ path: "README.unknown", overrides: unsupportedPatternOverride })).toBeUndefined();
  });

  it("returns undefined for unknown files", () => {
    expect(detectFiletype({ path: "README.unknown" })).toBeUndefined();
  });
});
