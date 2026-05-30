import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG, BUILTIN_FILETYPE_RULES } from "../../src/registry/builtin.js";
import { SUPPORTED_LANGUAGE_SERVER_IDS } from "../../src/registry/schema.js";

describe("BUILTIN_CATALOG", () => {
  it("contains the seven bundled server definitions", () => {
    expect(Object.keys(BUILTIN_CATALOG.servers).sort()).toEqual([...SUPPORTED_LANGUAGE_SERVER_IDS].sort());
  });

  it("uses argv arrays for every command", () => {
    for (const server of Object.values(BUILTIN_CATALOG.servers)) {
      expect(Array.isArray(server.command)).toBe(true);
      expect(server.command.every((part) => typeof part === "string")).toBe(true);
    }
  });

  it("orders specific root markers before .git", () => {
    expect(BUILTIN_CATALOG.servers.gopls.rootMarkers).toEqual(["go.work", "go.mod", ".git"]);
    expect(BUILTIN_CATALOG.servers.vtsls.rootMarkers).toEqual(
      expect.arrayContaining(["package.json", "tsconfig.json", "bun.lock", "bun.lockb"]),
    );
    expect(BUILTIN_CATALOG.servers.vtsls.rootMarkers.at(-1)).toBe(".git");
    expect(BUILTIN_CATALOG.servers["rust-analyzer"].rootMarkers.at(-1)).toBe(".git");
  });

  it("keeps bundled filetype rules in the registry", () => {
    expect(BUILTIN_FILETYPE_RULES.extensions[".ts"]).toBe("typescript");
    expect(BUILTIN_FILETYPE_RULES.extensions[".jsonc"]).toBe("jsonc");
  });
});
