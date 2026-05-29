import { describe, expect, it } from "vitest";
import extension from "../../src/index.js";

describe("extension entrypoint", () => {
  it("exports a Pi extension factory", () => {
    expect(typeof extension).toBe("function");
  });
});
