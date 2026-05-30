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

  it("detects JSON from content starting with {", () => {
    expect(detectFiletype({ path: "config.data", content: '{"key": "value"}' })).toBe("json");
  });

  it("detects JSON from content starting with [", () => {
    expect(detectFiletype({ path: "data.dat", content: '[1, 2, 3]' })).toBe("json");
  });

  it("detects YAML from content starting with ---", () => {
    expect(detectFiletype({ path: "data.dat", content: "---\nkey: value" })).toBe("yaml");
  });

  it("detects YAML from content starting with ---\\r\\n", () => {
    expect(detectFiletype({ path: "data.dat", content: "---\r\nkey: value" })).toBe("yaml");
  });

  it("detects Python from shebang", () => {
    expect(detectFiletype({ path: "script.dat", content: "#!/usr/bin/env python3\nprint(1)" })).toBe("python");
  });

  it("detects Python from shebang with version", () => {
    expect(detectFiletype({ path: "script.dat", content: "#!/usr/bin/python2.7\nprint(1)" })).toBe("python");
  });

  it("detects JavaScript from node shebang", () => {
    expect(detectFiletype({ path: "script.dat", content: "#!/usr/bin/env node\nconsole.log(1)" })).toBe("javascript");
  });

  it("does not detect content for empty or whitespace-only content", () => {
    expect(detectFiletype({ path: "empty.dat", content: "  " })).toBeUndefined();
    expect(detectFiletype({ path: "empty.dat", content: "" })).toBeUndefined();
    expect(detectFiletype({ path: "empty.dat", content: undefined })).toBeUndefined();
  });

  it("applies filename overrides", () => {
    expect(
      detectFiletype({
        path: "Dockerfile",
        overrides: { filenames: { "Dockerfile": "dockerfile" } },
      }),
    ).toBe("dockerfile");
  });

  it("applies exactFilenames overrides", () => {
    expect(
      detectFiletype({
        path: "Cargo.lock",
        overrides: { exactFilenames: { "Cargo.lock": "toml" } },
      }),
    ).toBe("toml");
  });

  it("merges filenames and exactFilenames overrides with exactFilenames taking precedence", () => {
    expect(
      detectFiletype({
        path: "MyFile",
        overrides: {
          filenames: { "MyFile": "json" },
          exactFilenames: { "MyFile": "yaml" },
        },
      }),
    ).toBe("yaml");
  });

  it("applies case-insensitive extension lookup", () => {
    expect(
      detectFiletype({
        path: "file.TS",
        overrides: { extensions: { ".ts": "typescript" } },
      }),
    ).toBe("typescript");
  });
});
