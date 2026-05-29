import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CATALOG } from "../../src/registry/builtin.js";
import { detectRoot } from "../../src/detect/root.js";

const sourceRepo = join(process.cwd(), "tests/fixtures/projects/monorepo");
let suiteTempDir: string;
let repo: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  suiteTempDir = await mkdtemp(join(tmpdir(), "pi-lsp-root-suite-"));
  repo = join(suiteTempDir, "monorepo");
  await cp(sourceRepo, repo, { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "keep"), "", "utf8");
});

afterAll(async () => {
  await rm(suiteTempDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectRoot", () => {
  it("prefers tsconfig over repository .git", async () => {
    const root = await detectRoot(join(repo, "apps/web/src/app.ts"), BUILTIN_CATALOG.servers.vtsls.rootMarkers);
    expect(root?.marker).toBe("tsconfig.json");
    expect(root?.rootDir).toBe(join(repo, "apps/web"));
  });

  it("prefers go.mod over repository .git", async () => {
    const root = await detectRoot(join(repo, "services/api/main.go"), BUILTIN_CATALOG.servers.gopls.rootMarkers);
    expect(root?.marker).toBe("go.mod");
    expect(root?.rootDir).toBe(join(repo, "services/api"));
  });

  it("prefers Cargo.toml over repository .git", async () => {
    const root = await detectRoot(
      join(repo, "crates/core/src/lib.rs"),
      BUILTIN_CATALOG.servers["rust-analyzer"].rootMarkers,
    );
    expect(root?.marker).toBe("Cargo.toml");
    expect(root?.rootDir).toBe(join(repo, "crates/core"));
  });

  it("falls back to .git when no specific marker exists", async () => {
    const root = await detectRoot(join(repo, "package.json"), ["missing.marker", ".git"]);
    expect(root?.marker).toBe(".git");
    expect(root?.rootDir).toBe(repo);
  });

  it("treats markers containing / as relative paths from each candidate directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-lsp-root-"));
    tempDirs.push(tempRoot);

    await mkdir(join(tempRoot, "project", "src"), { recursive: true });
    await writeFile(join(tempRoot, "project", "workspace.marker"), "root\n", "utf8");
    await writeFile(join(tempRoot, "project", "src", "Main.java"), "class Main {}\n", "utf8");

    const root = await detectRoot(join(tempRoot, "project", "src", "Main.java"), ["project/workspace.marker"]);

    expect(root?.marker).toBe("project/workspace.marker");
    expect(root?.rootDir).toBe(tempRoot);
  });

  it("returns undefined when no marker matches", async () => {
    const root = await detectRoot(join(repo, "apps/web/src/app.ts"), ["missing.marker"]);
    expect(root).toBeUndefined();
  });
});
