import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getBinDir, getLogsDir, getPackagesDir } from "../config/paths.js";
import { messageFromError, normalizeProcessEnv } from "../util/helpers.js";
import type {
  GithubInstallSpec,
  GoInstallSpec,
  InstalledServerMetadata,
  NpmInstallSpec,
  ServerDefinition,
  SystemInstallSpec,
} from "../registry/schema.js";
import { ConfigError, MissingBinaryError } from "../util/errors.js";
import { createInstalledServerMetadata, ensureManagedLspRoot } from "./lockfile.js";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;
export type DownloadFile = (url: string, destinationPath: string) => Promise<void>;

export interface InstallerOptions {
  runner?: CommandRunner;
  downloadFile?: DownloadFile;
  env?: Record<string, string>;
  now?: Date;
}

export interface InstallerResult {
  metadata: InstalledServerMetadata;
  logPath: string;
}

export async function installServerBackend(
  server: ServerDefinition,
  requestedVersion?: string,
  options: InstallerOptions = {},
): Promise<InstallerResult> {
  await ensureManagedLspRoot();

  try {
    const result =
      (await trySystemInstall(server, requestedVersion, options)) ??
      (await installByType(server, requestedVersion, options));
    await writeInstallLog(
      server.id,
      formatInstallLog([`Installed ${server.id}.`, `Command: ${result.metadata.resolvedCommand.join(" ")}`]),
    );
    return result;
  } catch (error) {
    await writeInstallLog(server.id, formatInstallLog([`Failed to install ${server.id}.`, messageFromError(error)]));
    throw error;
  }
}

export function buildNpmInstallCommand(
  serverId: string,
  install: NpmInstallSpec,
  requestedVersion?: string,
  env?: Record<string, string>,
): CommandInvocation {
  const packageDir = getServerPackageDir(serverId);
  const packages = resolveNpmPackages(install.packages, requestedVersion);
  const invocation: CommandInvocation = {
    command: "npm",
    args: [
      "install",
      "--prefix",
      packageDir,
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      ...Object.entries(packages).map(([name, version]) => `${name}@${version}`),
    ],
  };
  if (env) invocation.env = env;
  return invocation;
}

export function buildGoInstallCommand(
  _serverId: string,
  install: GoInstallSpec,
  requestedVersion?: string,
  env: Record<string, string> = normalizeProcessEnv(process.env),
): CommandInvocation {
  const version = requestedVersion ?? install.version ?? "latest";
  return {
    command: "go",
    args: ["install", `${install.module}@${version}`],
    env: { ...env, GOBIN: getBinDir() },
  };
}

export async function writeInstallLog(serverId: string, content: string): Promise<string> {
  const logPath = getInstallLogPath(serverId);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, content, "utf8");
  return logPath;
}

export function getInstallLogPath(serverId: string): string {
  return join(getLogsDir(), `${serverId}-install.log`);
}

export function getServerPackageDir(serverId: string): string {
  return join(getPackagesDir(), serverId);
}

export async function resolveSystemCommand(
  server: ServerDefinition,
  install: SystemInstallSpec,
  env: Record<string, string> = normalizeProcessEnv(process.env),
): Promise<string[]> {
  const command = install.command ?? (install.bin ? [install.bin] : server.command);
  if (command.length === 0) {
    throw new MissingBinaryError(server.id, "<empty command>");
  }

  const executable = await resolveExecutable(command[0]!, env, server.id);
  return [executable, ...command.slice(1)];
}

async function trySystemInstall(
  server: ServerDefinition,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult | undefined> {
  if (requestedVersion || server.install.type === "system") return undefined;

  try {
    return await installSystemServer(server, buildSystemFallbackInstall(server), undefined, options);
  } catch (error) {
    if (error instanceof MissingBinaryError) return undefined;
    throw error;
  }
}

function buildSystemFallbackInstall(server: ServerDefinition): SystemInstallSpec {
  const bin = getInstallBinName(server);
  return { type: "system", command: [bin, ...systemFallbackArgs(server)] };
}

export function getInstallBinName(server: ServerDefinition): string {
  switch (server.install.type) {
    case "npm":
    case "go":
    case "github":
      return server.install.bin;
    case "system":
      return server.install.bin ?? server.install.command?.[0] ?? server.command[0] ?? server.id;
  }
}

function systemFallbackArgs(server: ServerDefinition): string[] {
  const command = server.command[0];
  return command?.includes("{installBin}") ? commandArgsFromServerTemplate(server.command) : [];
}

async function installByType(
  server: ServerDefinition,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult> {
  switch (server.install.type) {
    case "npm":
      return installNpmServer(server, server.install, requestedVersion, options);
    case "go":
      return installGoServer(server, server.install, requestedVersion, options);
    case "github":
      return installGithubServer(server, server.install, requestedVersion, options);
    case "system":
      return installSystemServer(server, server.install, requestedVersion, options);
  }
}

async function installNpmServer(
  server: ServerDefinition,
  install: NpmInstallSpec,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const packageDir = getServerPackageDir(server.id);
  const command = buildNpmInstallCommand(server.id, install, requestedVersion, options.env);
  await mkdir(packageDir, { recursive: true });
  await runChecked(runner, command);

  const packageBin = join(packageDir, "node_modules", ".bin", install.bin);
  const resolvedBin = join(getBinDir(), install.bin);
  await linkExecutable(packageBin, resolvedBin, server.id);

  return {
    metadata: createInstalledServerMetadata({
      installer: "npm",
      requestedVersion,
      packages: resolveNpmPackages(install.packages, requestedVersion),
      resolvedCommand: [resolvedBin, ...commandArgsFromServerTemplate(server.command)],
      packageDir,
      binDir: getBinDir(),
      installedAt: options.now,
    }),
    logPath: getInstallLogPath(server.id),
  };
}

async function installGoServer(
  server: ServerDefinition,
  install: GoInstallSpec,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const command = buildGoInstallCommand(server.id, install, requestedVersion, options.env);
  await runChecked(runner, command);

  return {
    metadata: createInstalledServerMetadata({
      installer: "go",
      requestedVersion: requestedVersion ?? install.version,
      resolvedCommand: [join(getBinDir(), install.bin)],
      binDir: getBinDir(),
      installedAt: options.now,
    }),
    logPath: getInstallLogPath(server.id),
  };
}

async function installGithubServer(
  server: ServerDefinition,
  install: GithubInstallSpec,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const downloadFile = options.downloadFile ?? defaultDownloadFile;
  const assetName = resolveGithubAssetName(install, requestedVersion);
  const url = buildGithubAssetUrl(install, assetName, requestedVersion ?? install.version);
  const packageDir = getServerPackageDir(server.id);
  const archivePath = join(tmpdir(), `pi-lsp-${server.id}-${process.pid}-${Date.now()}-${basename(assetName)}`);
  await mkdir(packageDir, { recursive: true });
  await downloadFile(url, archivePath);

  const extractedPath = await extractGithubAsset(runner, archivePath, packageDir, install.stripComponents ?? 0);
  const needsManagedBin = commandUsesInstallBin(server.command);
  const resolvedBin = join(getBinDir(), install.bin);
  const resolvedCommand = needsManagedBin
    ? [resolvedBin, ...commandArgsFromServerTemplate(server.command)]
    : server.command;

  if (needsManagedBin) {
    const packageBin = await prepareGithubExecutable(packageDir, install.bin, extractedPath, server.id);
    await linkExecutable(packageBin, resolvedBin, server.id);
  }

  return {
    metadata: createInstalledServerMetadata({
      installer: "github",
      requestedVersion: requestedVersion ?? install.version,
      resolvedCommand,
      packageDir,
      binDir: needsManagedBin ? getBinDir() : undefined,
      installedAt: options.now,
    }),
    logPath: getInstallLogPath(server.id),
  };
}

async function installSystemServer(
  server: ServerDefinition,
  install: SystemInstallSpec,
  requestedVersion: string | undefined,
  options: InstallerOptions,
): Promise<InstallerResult> {
  const resolvedCommand = await resolveSystemCommand(server, install, options.env ?? normalizeProcessEnv(process.env));
  return {
    metadata: createInstalledServerMetadata({
      installer: "system",
      requestedVersion,
      resolvedCommand,
      installedAt: options.now,
    }),
    logPath: getInstallLogPath(server.id),
  };
}

async function runChecked(runner: CommandRunner, invocation: CommandInvocation): Promise<CommandResult> {
  const result = await runner(invocation);
  if (result.code !== 0) {
    throw new ConfigError(
      `${invocation.command} ${invocation.args.join(" ")} failed with exit code ${result.code}: ${tail(result.stderr || result.stdout)}`,
    );
  }
  return result;
}

function resolveNpmPackages(
  packages: Record<string, string>,
  requestedVersion: string | undefined,
): Record<string, string> {
  const entries = Object.entries(packages);
  if (!requestedVersion || entries.length === 0) {
    return { ...packages };
  }

  const [primaryName] = entries[0]!;
  return { ...packages, [primaryName]: requestedVersion };
}

function commandArgsFromServerTemplate(command: string[]): string[] {
  return command.slice(1).filter((arg) => !arg.includes("{installBin}") && !arg.includes("{installDir}"));
}

function commandUsesInstallBin(command: string[]): boolean {
  return command.some((part) => part.includes("{installBin}"));
}

async function linkExecutable(target: string, linkPath: string, serverId: string): Promise<void> {
  await assertExecutable(target, target, serverId);
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { force: true });
  try {
    await symlink(target, linkPath);
  } catch {
    await copyFile(target, linkPath);
    await chmod(linkPath, 0o755).catch(() => undefined);
  }
}

async function prepareGithubExecutable(
  packageDir: string,
  binName: string,
  extractedPath: string | undefined,
  serverId: string,
): Promise<string> {
  const expectedPath = join(packageDir, binName);
  if (await isExecutable(expectedPath)) return expectedPath;

  if (extractedPath && (await isExecutable(extractedPath))) {
    await copyFile(extractedPath, expectedPath);
    await chmod(expectedPath, 0o755).catch(() => undefined);
    return expectedPath;
  }

  throw new MissingBinaryError(serverId, expectedPath);
}

async function resolveExecutable(command: string, env: Record<string, string>, serverId: string): Promise<string> {
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    const absolute = isAbsolute(command) ? command : resolve(command);
    await assertExecutable(absolute, command, serverId);
    return absolute;
  }

  const rawPath = env.PATH ?? "";

  let pathEntries: string[];
  if (process.platform === "win32" && (rawPath.includes("/c/") || rawPath.includes("/usr/"))) {
    // Git Bash / MSYS / MinGW expose a POSIX-style, ":"-separated PATH.
    pathEntries = rawPath.split(":").filter(Boolean);
  } else {
    pathEntries = rawPath.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  }

  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      let normalized = directory;

      // Convert an MSYS "/c/Users/foo" entry to "C:\Users\foo" for fs.access().
      if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(normalized)) {
        const drive = normalized[1]!.toUpperCase();
        normalized = `${drive}:\\${normalized.slice(3).replace(/\//g, "\\")}`;
      }

      const candidate = join(normalized, `${command}${extension}`);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  throw new MissingBinaryError(serverId, command);
}

async function assertExecutable(path: string, originalCommand: string, serverId: string): Promise<void> {
  if (!(await isExecutable(path))) {
    throw new MissingBinaryError(serverId, originalCommand);
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveGithubAssetName(install: GithubInstallSpec, requestedVersion: string | undefined): string {
  if (!install.asset) {
    return install.bin;
  }

  const version = requestedVersion ?? install.version;
  if (install.asset.includes("{version}") && !version) {
    throw new ConfigError(`GitHub installer for ${install.repo} requires a version because asset uses {version}.`);
  }

  return install.asset.replaceAll("{version}", version ?? "latest").replaceAll("{platform}", getGithubPlatformToken());
}

export function buildGithubAssetUrl(
  install: GithubInstallSpec,
  assetName: string,
  version: string | undefined,
): string {
  if (install.downloadUrl) {
    const resolvedVersion = version ?? "latest";
    return install.downloadUrl.replaceAll("{version}", resolvedVersion).replaceAll("{asset}", assetName);
  }

  const releasePath = version ? `download/${version}` : "latest/download";
  return `https://github.com/${install.repo}/releases/${releasePath}/${assetName}`;
}

async function extractGithubAsset(
  runner: CommandRunner,
  archivePath: string,
  packageDir: string,
  stripComponents: number,
): Promise<string | undefined> {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    const args = ["-xzf", archivePath, "-C", packageDir];
    if (stripComponents > 0) args.push("--strip-components", String(stripComponents));
    await runChecked(runner, { command: "tar", args });
    return undefined;
  }

  if (archivePath.endsWith(".zip")) {
    await runChecked(runner, { command: "unzip", args: ["-q", archivePath, "-d", packageDir] });
    return undefined;
  }

  const destination = join(packageDir, basename(archivePath));
  await copyFile(archivePath, destination);
  await chmod(destination, 0o755).catch(() => undefined);
  return destination;
}

export function getGithubPlatformToken(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "arm") return "arm-unknown-linux-gnueabihf";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }

  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "ia32") return "i686-pc-windows-msvc";
  }

  return `${platform}-${arch}`;
}

async function defaultDownloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ConfigError(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destinationPath, buffer);
}

export async function defaultCommandRunner(invocation: CommandInvocation): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function formatInstallLog(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function tail(value: string): string {
  const lines = value.trim().split(/\r?\n/u);
  return lines.slice(-10).join("\n");
}
