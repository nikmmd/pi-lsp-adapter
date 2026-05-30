import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProcessRegistryPath } from "../config/paths.js";
import { delay, isNodeError, isPlainObject } from "../util/helpers.js";

export interface LspProcessEntry {
  id: string;
  serverId: string;
  rootDir: string;
  pid: number;
  command: string[];
  cwd: string;
  startedAt: string;
  ownerId: string;
  ownerPid: number;
}

export interface LspPidFile {
  processes: LspProcessEntry[];
}

export interface ProcessProbe {
  isRunning(pid: number): boolean | Promise<boolean>;
  commandMatches(pid: number, command: string[]): boolean | Promise<boolean>;
  terminate(pid: number, signal: NodeJS.Signals): void | Promise<void>;
}

export interface LspProcessRegistryOptions {
  path?: string;
  dir?: string;
  ownerId: string;
  probe?: ProcessProbe;
  terminateGraceMs?: number;
}

export interface CleanupResult {
  terminated: LspProcessEntry[];
  removed: LspProcessEntry[];
  kept: LspProcessEntry[];
}

export class LspProcessRegistry {
  private readonly path: string;
  private readonly dir: string;
  private readonly ownerId: string;
  private readonly probe: ProcessProbe;
  private readonly terminateGraceMs: number;
  private mutationQueue = Promise.resolve();

  constructor(options: LspProcessRegistryOptions) {
    this.ownerId = options.ownerId;
    this.path = options.path ?? getProcessRegistryPath(options.ownerId);
    this.dir = options.dir ?? dirname(this.path);
    this.probe = options.probe ?? nodeProcessProbe;
    this.terminateGraceMs = options.terminateGraceMs ?? 1500;
  }

  async list(): Promise<LspProcessEntry[]> {
    return this.readAllEntries();
  }

  async register(
    entry: Omit<LspProcessEntry, "ownerId" | "ownerPid" | "startedAt"> &
      Partial<Pick<LspProcessEntry, "ownerId" | "ownerPid" | "startedAt">>,
  ): Promise<void> {
    await this.withMutation(async () => {
      const pidFile = await this.readOwnerFile();
      const nextEntry: LspProcessEntry = {
        ...entry,
        ownerId: entry.ownerId ?? this.ownerId,
        ownerPid: entry.ownerPid ?? process.pid,
        startedAt: entry.startedAt ?? new Date().toISOString(),
      };
      pidFile.processes = [...pidFile.processes.filter((item) => !isSameOwnerSlot(item, nextEntry)), nextEntry];
      await this.writeOwnerFile(pidFile);
    });
  }

  async unregister(id: string, pid?: number): Promise<void> {
    await this.withMutation(async () => {
      const pidFile = await this.readOwnerFile();
      pidFile.processes = pidFile.processes.filter((entry) => {
        if (entry.id !== id) return true;
        if (pid === undefined) return false;
        return entry.pid !== pid;
      });
      await this.writeOwnerFile(pidFile);
    });
  }

  async cleanupStaleProcesses(): Promise<CleanupResult> {
    const entries = await this.readAllEntries();
    const result: CleanupResult = { terminated: [], removed: [], kept: [] };

    for (const entry of entries) {
      if (!(await this.probe.isRunning(entry.pid))) {
        result.removed.push(entry);
        continue;
      }

      if (!(await this.isStaleOwner(entry))) {
        result.kept.push(entry);
        continue;
      }

      if (!(await this.probe.commandMatches(entry.pid, entry.command))) {
        result.kept.push(entry);
        continue;
      }

      await this.terminateEntry(entry);
      result.terminated.push(entry);
    }

    await this.rewriteAllEntries(result.kept);
    return result;
  }

  async terminateOwnedProcesses(): Promise<CleanupResult> {
    return this.terminateProcesses((entry) => entry.ownerId === this.ownerId);
  }

  async terminateProcesses(predicate: (entry: LspProcessEntry) => boolean = () => true): Promise<CleanupResult> {
    const entries = await this.readAllEntries();
    const result: CleanupResult = { terminated: [], removed: [], kept: [] };

    for (const entry of entries) {
      if (!predicate(entry)) {
        result.kept.push(entry);
        continue;
      }

      if (!(await this.probe.isRunning(entry.pid))) {
        result.removed.push(entry);
        continue;
      }

      if (!(await this.probe.commandMatches(entry.pid, entry.command))) {
        result.kept.push(entry);
        continue;
      }

      await this.terminateEntry(entry);
      result.terminated.push(entry);
    }

    await this.rewriteAllEntries(result.kept);
    return result;
  }

  private async isStaleOwner(entry: LspProcessEntry): Promise<boolean> {
    return entry.ownerPid === process.pid || !(await this.probe.isRunning(entry.ownerPid));
  }

  private async terminateEntry(entry: LspProcessEntry): Promise<void> {
    await this.probe.terminate(entry.pid, "SIGTERM");
    await delay(this.terminateGraceMs);
    if (await this.probe.isRunning(entry.pid)) {
      await this.probe.terminate(entry.pid, "SIGKILL");
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readOwnerFile(): Promise<LspPidFile> {
    return this.readFile(this.path);
  }

  private async readAllEntries(): Promise<LspProcessEntry[]> {
    const files = await this.registryFiles();
    const entries: LspProcessEntry[] = [];
    for (const file of files) {
      entries.push(...(await this.readFile(file)).processes);
    }
    return normalizePidFile({ processes: entries }).processes;
  }

  private async registryFiles(): Promise<string[]> {
    const files = new Set<string>();
    files.add(this.path);

    try {
      for (const entry of await readdir(this.dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          files.add(join(this.dir, entry.name));
        }
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    return [...files].sort();
  }

  private async rewriteAllEntries(entries: LspProcessEntry[]): Promise<void> {
    const grouped = new Map<string, LspProcessEntry[]>();
    for (const entry of entries) {
      const filePath = this.pathForOwner(entry.ownerId);
      grouped.set(filePath, [...(grouped.get(filePath) ?? []), entry]);
    }

    for (const filePath of await this.registryFiles()) {
      await this.writeFile(filePath, { processes: grouped.get(filePath) ?? [] });
      grouped.delete(filePath);
    }

    for (const [filePath, processes] of grouped) {
      await this.writeFile(filePath, { processes });
    }
  }

  private pathForOwner(ownerId: string): string {
    if (ownerId === this.ownerId) return this.path;
    return join(this.dir, `${safePathSegment(ownerId)}.json`);
  }

  private async readFile(path: string): Promise<LspPidFile> {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim() === "") return { processes: [] };

      const parsed: unknown = JSON.parse(raw);
      if (!isPidFile(parsed)) return { processes: [] };
      return { processes: parsed.processes };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { processes: [] };
      }
      if (error instanceof SyntaxError) {
        return { processes: [] };
      }
      throw error;
    }
  }

  private async writeOwnerFile(pidFile: LspPidFile): Promise<void> {
    await this.writeFile(this.path, pidFile);
  }

  private async writeFile(path: string, pidFile: LspPidFile): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const normalized = normalizePidFile(pidFile);
    if (normalized.processes.length === 0) {
      await rm(path, { force: true });
      return;
    }

    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }
}

export const nodeProcessProbe: ProcessProbe = {
  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error) && error.code === "EPERM";
    }
  },

  async commandMatches(pid: number, command: string[]): Promise<boolean> {
    if (process.platform !== "linux") return true;
    const expected = command[0];
    if (!expected) return false;

    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
      const actualParts = cmdline.split("\0").filter(Boolean);
      const expectedBasename = expected.split("/").at(-1);
      return actualParts.some((part) => part === expected || part.endsWith(`/${expectedBasename}`));
    } catch {
      return false;
    }
  },

  terminate(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") throw error;
    }
  },
};

function normalizePidFile(pidFile: LspPidFile): LspPidFile {
  return {
    processes: [...pidFile.processes].sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.ownerId.localeCompare(right.ownerId) || left.pid - right.pid,
    ),
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function isSameOwnerSlot(
  left: Pick<LspProcessEntry, "id" | "ownerId">,
  right: Pick<LspProcessEntry, "id" | "ownerId">,
): boolean {
  return left.id === right.id && left.ownerId === right.ownerId;
}

function isPidFile(value: unknown): value is LspPidFile {
  if (!isPlainObject(value) || !Array.isArray(value.processes)) return false;
  return value.processes.every(isProcessEntry);
}

function isProcessEntry(value: unknown): value is LspProcessEntry {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    typeof value.serverId === "string" &&
    typeof value.rootDir === "string" &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    Array.isArray(value.command) &&
    value.command.every((entry) => typeof entry === "string") &&
    typeof value.cwd === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.ownerPid === "number" &&
    Number.isInteger(value.ownerPid) &&
    value.ownerPid > 0
  );
}
