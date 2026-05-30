import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getProcessRegistryPath } from "../config/paths.js";
import { ConfigError } from "../util/errors.js";
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
  private readonly ownerId: string;
  private readonly probe: ProcessProbe;
  private readonly terminateGraceMs: number;

  constructor(options: LspProcessRegistryOptions) {
    this.path = options.path ?? getProcessRegistryPath();
    this.ownerId = options.ownerId;
    this.probe = options.probe ?? nodeProcessProbe;
    this.terminateGraceMs = options.terminateGraceMs ?? 1500;
  }

  async list(): Promise<LspProcessEntry[]> {
    return (await this.read()).processes;
  }

  async register(
    entry: Omit<LspProcessEntry, "ownerId" | "ownerPid" | "startedAt"> &
      Partial<Pick<LspProcessEntry, "ownerId" | "ownerPid" | "startedAt">>,
  ): Promise<void> {
    const pidFile = await this.read();
    const nextEntry: LspProcessEntry = {
      ...entry,
      ownerId: entry.ownerId ?? this.ownerId,
      ownerPid: entry.ownerPid ?? process.pid,
      startedAt: entry.startedAt ?? new Date().toISOString(),
    };
    pidFile.processes = [...pidFile.processes.filter((item) => !isSameOwnerSlot(item, nextEntry)), nextEntry];
    await this.write(pidFile);
  }

  async unregister(id: string, pid?: number): Promise<void> {
    const pidFile = await this.read();
    pidFile.processes = pidFile.processes.filter((entry) => {
      if (entry.id !== id) return true; // keep entries with different id
      if (pid === undefined) return false; // remove entries matching by id when no pid provided
      return entry.pid !== pid; // when pid provided, only remove if pid also matches
    });
    await this.write(pidFile);
  }

  async cleanupStaleProcesses(): Promise<CleanupResult> {
    const entries = await this.list();
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

    await this.write({ processes: result.kept });
    return result;
  }

  async terminateOwnedProcesses(): Promise<CleanupResult> {
    return this.terminateProcesses((entry) => entry.ownerId === this.ownerId);
  }

  async terminateProcesses(predicate: (entry: LspProcessEntry) => boolean = () => true): Promise<CleanupResult> {
    const entries = await this.list();
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

    await this.write({ processes: result.kept });
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

  private async read(): Promise<LspPidFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPidFile(parsed)) {
        throw new ConfigError(`Invalid LSP pid file at ${this.path}: expected { processes: [...] }.`);
      }
      return { processes: parsed.processes };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { processes: [] };
      }
      if (error instanceof SyntaxError) {
        throw new ConfigError(`Invalid LSP pid file at ${this.path}: ${error.message}`);
      }
      throw error;
    }
  }

  private async write(pidFile: LspPidFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalizePidFile(pidFile), null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
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
