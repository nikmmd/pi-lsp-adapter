import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspProcessRegistry, type LspProcessEntry, type ProcessProbe } from "../../src/lsp/processRegistry.js";

let tempDir: string;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-lsp-pids-"));
  registryPath = join(tempDir, "lsp.pid.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("LspProcessRegistry", () => {
  it("registers entries in the session pid file with the current owner", async () => {
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-a", probe: fakeProbe() });

    await registry.register(entry({ id: "pyright:/repo", ownerId: undefined, ownerPid: undefined }));

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "pyright:/repo", ownerId: "owner-a", ownerPid: process.pid });
    await expect(readFile(registryPath, "utf8")).resolves.toContain("pyright:/repo");
  });

  it("treats an empty or invalid pid file as empty runtime state", async () => {
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-a", probe: fakeProbe() });

    await writeFile(registryPath, "", "utf8");
    await expect(registry.list()).resolves.toEqual([]);

    await writeFile(registryPath, "{not-json", "utf8");
    await expect(registry.list()).resolves.toEqual([]);

    await writeFile(registryPath, JSON.stringify({ processes: "invalid" }), "utf8");
    await expect(registry.list()).resolves.toEqual([]);
  });

  it("terminates stale entries whose owner process is gone and keeps live owners", async () => {
    const probe = fakeProbe({ running: new Set([10, 20, 30]), matching: new Set([10, 20, 30]) });
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-new", probe, terminateGraceMs: 0 });
    await registry.register(entry({ id: "stale", pid: 10, ownerId: "owner-old", ownerPid: 9999 }));
    await registry.register(entry({ id: "live-owner", pid: 20, ownerId: "owner-other", ownerPid: 30 }));

    const result = await registry.cleanupStaleProcesses();

    expect(result.terminated.map((item) => item.id)).toEqual(["stale"]);
    expect(result.kept.map((item) => item.id)).toEqual(["live-owner"]);
    expect(probe.terminated).toEqual([
      { pid: 10, signal: "SIGTERM" },
      { pid: 10, signal: "SIGKILL" },
    ]);
    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ id: "live-owner" })]);
  });

  it("does not terminate a running pid when the command no longer matches", async () => {
    const probe = fakeProbe({ running: new Set([10]), matching: new Set() });
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-new", probe, terminateGraceMs: 0 });
    await registry.register(entry({ id: "reused-pid", pid: 10, ownerId: "owner-old", ownerPid: 9999 }));

    const result = await registry.cleanupStaleProcesses();

    expect(result.kept.map((item) => item.id)).toEqual(["reused-pid"]);
    expect(probe.terminated).toEqual([]);
  });

  it("terminates only owned processes during session shutdown", async () => {
    const probe = fakeProbe({ running: new Set([10, 20]), matching: new Set([10, 20]) });
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-a", probe, terminateGraceMs: 0 });
    await registry.register(entry({ id: "owned", pid: 10, ownerId: "owner-a", ownerPid: process.pid }));
    await registry.register(entry({ id: "other", pid: 20, ownerId: "owner-b", ownerPid: 12345 }));

    const result = await registry.terminateOwnedProcesses();

    expect(result.terminated.map((item) => item.id)).toEqual(["owned"]);
    expect(result.kept.map((item) => item.id)).toEqual(["other"]);
  });

  it("keeps replacement entries when an old pid unregisters late", async () => {
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-a", probe: fakeProbe() });
    await registry.register(entry({ id: "vtsls:/repo", pid: 10 }));
    await registry.register(entry({ id: "vtsls:/repo", pid: 20 }));

    await registry.unregister("vtsls:/repo", 10);

    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ id: "vtsls:/repo", pid: 20 })]);
  });

  it("keeps same server/root entries for different live owners", async () => {
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-new", probe: fakeProbe() });
    await registry.register(entry({ id: "vtsls:/repo", pid: 10, ownerId: "owner-a", ownerPid: 100 }));
    await registry.register(entry({ id: "vtsls:/repo", pid: 20, ownerId: "owner-b", ownerPid: 200 }));

    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({ id: "vtsls:/repo", pid: 10, ownerId: "owner-a" }),
      expect.objectContaining({ id: "vtsls:/repo", pid: 20, ownerId: "owner-b" }),
    ]);
  });

  it("serializes concurrent unregister writes during shutdown", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1780111601295);
    const registry = new LspProcessRegistry({ path: registryPath, ownerId: "owner-a", probe: fakeProbe() });
    const entries = Array.from({ length: 8 }, (_value, index) =>
      entry({ id: `vtsls:/repo/${index}`, pid: 100 + index }),
    );
    for (const processEntry of entries) {
      await registry.register(processEntry);
    }

    await Promise.all(entries.map((processEntry) => registry.unregister(processEntry.id, processEntry.pid)));

    await expect(registry.list()).resolves.toEqual([]);
  });
});

function entry(
  overrides: Partial<LspProcessEntry> = {},
): Omit<LspProcessEntry, "ownerId" | "ownerPid" | "startedAt"> & Partial<LspProcessEntry> {
  return {
    id: "pyright:/repo",
    serverId: "pyright",
    rootDir: "/repo",
    pid: 10,
    command: ["/bin/pyright-langserver", "--stdio"],
    cwd: "/repo",
    startedAt: "2026-05-28T00:00:00.000Z",
    ownerId: "owner-a",
    ownerPid: process.pid,
    ...overrides,
  };
}

function fakeProbe(options: { running?: Set<number>; matching?: Set<number> } = {}): ProcessProbe & {
  terminated: Array<{ pid: number; signal: NodeJS.Signals }>;
} {
  const running = options.running ?? new Set<number>();
  const matching = options.matching ?? new Set<number>();
  const terminated: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    terminated,
    isRunning(pid: number) {
      return running.has(pid) || pid === process.pid;
    },
    commandMatches(pid: number) {
      return matching.has(pid);
    },
    terminate(pid: number, signal: NodeJS.Signals) {
      terminated.push({ pid, signal });
    },
  };
}
