import { afterEach, describe, expect, it } from "vitest";
import { normalizeProcessEnv } from "../../src/util/helpers.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("normalizeProcessEnv", () => {
  it("mirrors a Windows case-folded Path key to PATH on win32", () => {
    setPlatform("win32");

    const normalized = normalizeProcessEnv({ Path: "C:\\Windows", Pathext: ".EXE;.CMD" } as NodeJS.ProcessEnv);

    expect(normalized.PATH).toBe("C:\\Windows");
    expect(normalized.PATHEXT).toBe(".EXE;.CMD");
    // Original casing is preserved alongside the mirrored upper-case key.
    expect(normalized.Path).toBe("C:\\Windows");
  });

  it("leaves case-sensitive variables untouched on win32", () => {
    setPlatform("win32");

    const normalized = normalizeProcessEnv({ GoPath: "/go", PATH: "C:\\Windows" } as NodeJS.ProcessEnv);

    expect(normalized.GoPath).toBe("/go");
    expect(normalized.GOPATH).toBeUndefined();
    expect(normalized.PATH).toBe("C:\\Windows");
  });

  it("does not synthesize upper-case keys off win32", () => {
    setPlatform("linux");

    const normalized = normalizeProcessEnv({ Path: "/usr/bin" } as NodeJS.ProcessEnv);

    expect(normalized.Path).toBe("/usr/bin");
    expect(normalized.PATH).toBeUndefined();
  });

  it("skips non-string values", () => {
    setPlatform("linux");

    const normalized = normalizeProcessEnv({ PATH: "/usr/bin", MISSING: undefined } as NodeJS.ProcessEnv);

    expect(normalized.PATH).toBe("/usr/bin");
    expect("MISSING" in normalized).toBe(false);
  });
});
