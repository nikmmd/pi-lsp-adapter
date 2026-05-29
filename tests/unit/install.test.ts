import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBinDir, getLockfilePath, getLogsDir, getManagedLspRoot, getPackagesDir } from "../../src/config/paths.js";
import {
  buildGithubAssetUrl,
  buildNpmInstallCommand,
  getGithubPlatformToken,
  installServerBackend,
  resolveGithubAssetName,
  resolveSystemCommand,
} from "../../src/install/installers.js";
import { createInstalledServerMetadata, readLockfile, writeLockfile } from "../../src/install/lockfile.js";
import { formatInstallCommand, LspInstallManager, type BackendInstaller } from "../../src/install/manager.js";
import { parseServerVersionSpec } from "../../src/install/version.js";
import { BUILTIN_CATALOG } from "../../src/registry/builtin.js";
import type { InstalledServerMetadata, ServerDefinition } from "../../src/registry/schema.js";
import { ConfigError } from "../../src/util/errors.js";

let originalHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-install-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
});

describe("parseServerVersionSpec", () => {
  it("parses a server id with an exact version", () => {
    expect(parseServerVersionSpec("pyright@1.1.405")).toEqual({ serverId: "pyright", version: "1.1.405" });
  });

  it("parses a server id without a version", () => {
    expect(parseServerVersionSpec("vtsls")).toEqual({ serverId: "vtsls" });
  });

  it.each(["", "@1.0.0", "pyright@", "py right", "foo/bar", "pyright@1@2", "pyright@1 2"])(
    "rejects malformed server spec %j",
    (input) => {
      expect(() => parseServerVersionSpec(input)).toThrow();
    },
  );
});

describe("lockfile helpers", () => {
  it("reads a missing lockfile as empty and atomically writes server metadata", async () => {
    await expect(readLockfile()).resolves.toEqual({ servers: {} });

    const metadata = createInstalledServerMetadata({
      installer: "npm",
      requestedVersion: "1.1.405",
      packages: { pyright: "1.1.405" },
      resolvedCommand: [join(getBinDir(), "pyright-langserver"), "--stdio"],
      packageDir: join(getPackagesDir(), "pyright"),
      binDir: getBinDir(),
      installedAt: new Date("2026-05-28T00:00:00.000Z"),
    });

    await writeLockfile({ servers: { pyright: metadata } });

    expect(await readLockfile()).toEqual({ servers: { pyright: metadata } });
    await expect(readFile(getLockfilePath(), "utf8")).resolves.toContain('"pyright"');
    await expect(readdir(getManagedLspRoot())).resolves.toEqual(
      expect.arrayContaining(["bin", "cache", "logs", "lsp.lock.json", "packages", "registry", "workspaces"]),
    );
    const lockDirEntries = await readdir(dirname(getLockfilePath()));
    expect(lockDirEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("reads the legacy lock.json when lsp.lock.json has not been created yet", async () => {
    const legacyLockfilePath = join(dirname(getLockfilePath()), "lock.json");
    await mkdir(dirname(legacyLockfilePath), { recursive: true });
    await writeFile(
      legacyLockfilePath,
      `${JSON.stringify({
        servers: {
          pyright: {
            installer: "npm",
            resolvedCommand: ["/tmp/pyright-langserver", "--stdio"],
            installedAt: "2026-05-28T00:00:00.000Z",
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(readLockfile()).resolves.toEqual({
      servers: {
        pyright: {
          installer: "npm",
          resolvedCommand: ["/tmp/pyright-langserver", "--stdio"],
          installedAt: "2026-05-28T00:00:00.000Z",
        },
      },
    });
  });

  it("throws on corrupt lockfiles instead of treating them as empty", async () => {
    await mkdir(dirname(getLockfilePath()), { recursive: true });
    await writeFile(getLockfilePath(), "{not-json", "utf8");

    await expect(readLockfile()).rejects.toThrow(ConfigError);
    await expect(readLockfile()).rejects.toThrow("Invalid LSP lockfile");
  });
});

describe("installer backends", () => {
  it("constructs safer npm install argv without a shell", () => {
    const install = BUILTIN_CATALOG.servers.pyright.install;
    if (install.type !== "npm") throw new Error("pyright test fixture must use npm install");

    const command = buildNpmInstallCommand("pyright", install, "1.1.405");

    expect(command).toEqual({
      command: "npm",
      args: [
        "install",
        "--prefix",
        join(getPackagesDir(), "pyright"),
        "--ignore-scripts",
        "--no-audit",
        "--fund=false",
        "pyright@1.1.405",
      ],
    });
  });

  it("runs npm installer through a structured runner and records resolved metadata", async () => {
    const invocations: Array<{ command: string; args: string[] }> = [];

    const result = await installServerBackend(BUILTIN_CATALOG.servers.pyright, "1.1.405", {
      now: new Date("2026-05-28T00:00:00.000Z"),
      runner: async (invocation) => {
        invocations.push({ command: invocation.command, args: invocation.args });
        await createNpmBin(invocation.args, "pyright-langserver");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(invocations).toEqual([
      {
        command: "npm",
        args: [
          "install",
          "--prefix",
          join(getPackagesDir(), "pyright"),
          "--ignore-scripts",
          "--no-audit",
          "--fund=false",
          "pyright@1.1.405",
        ],
      },
    ]);
    expect(result.metadata).toEqual({
      installer: "npm",
      requestedVersion: "1.1.405",
      packages: { pyright: "1.1.405" },
      resolvedCommand: [join(getBinDir(), "pyright-langserver"), "--stdio"],
      packageDir: join(getPackagesDir(), "pyright"),
      binDir: getBinDir(),
      installedAt: "2026-05-28T00:00:00.000Z",
    });
    await expect(readFile(join(getLogsDir(), "pyright-install.log"), "utf8")).resolves.toContain("Installed pyright");
  });

  it("fails npm installs when the expected binary was not created", async () => {
    await expect(
      installServerBackend(BUILTIN_CATALOG.servers.pyright, "1.1.405", {
        runner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      }),
    ).rejects.toThrow("pyright binary not found");
    await expect(readFile(join(getLogsDir(), "pyright-install.log"), "utf8")).resolves.toContain("binary not found");
  });

  it("uses an existing PATH language-server binary before managed installs", async () => {
    const binDir = join(tempHome, "system-bin");
    const executable = join(binDir, "pyright-langserver");
    await createExecutable(executable);

    const result = await installServerBackend(BUILTIN_CATALOG.servers.pyright, undefined, {
      now: new Date("2026-05-28T00:00:00.000Z"),
      env: { PATH: binDir },
      runner: async () => {
        throw new Error("managed install should not run when system binary is available");
      },
    });

    expect(result.metadata).toEqual({
      installer: "system",
      resolvedCommand: [executable, "--stdio"],
      installedAt: "2026-05-28T00:00:00.000Z",
    });
  });

  it("bypasses system binary discovery when the user requests an exact version", async () => {
    const binDir = join(tempHome, "system-bin");
    await createExecutable(join(binDir, "pyright-langserver"));
    const invocations: string[][] = [];

    await installServerBackend(BUILTIN_CATALOG.servers.pyright, "1.1.410", {
      env: { PATH: binDir },
      runner: async (invocation) => {
        invocations.push(invocation.args);
        await createNpmBin(invocation.args, "pyright-langserver");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("pyright@1.1.410");
  });

  it("uses a PATH jdtls wrapper instead of the managed Java launcher template", async () => {
    const binDir = join(tempHome, "system-bin");
    const executable = join(binDir, "jdtls");
    await createExecutable(executable);

    const result = await installServerBackend(BUILTIN_CATALOG.servers.jdtls, undefined, {
      now: new Date("2026-05-28T00:00:00.000Z"),
      env: { PATH: binDir },
    });

    expect(result.metadata).toEqual({
      installer: "system",
      resolvedCommand: [executable],
      installedAt: "2026-05-28T00:00:00.000Z",
    });
  });

  it.each([
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
    ["linux", "arm", "arm-unknown-linux-gnueabihf"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["win32", "ia32", "i686-pc-windows-msvc"],
  ])("maps %s/%s to the upstream rust-analyzer GitHub asset token", (platform, arch, expected) => {
    expect(getGithubPlatformToken(platform, arch)).toBe(expected);
  });

  it("resolves the pinned rust-analyzer asset name for the current platform", () => {
    const install = BUILTIN_CATALOG.servers["rust-analyzer"].install;
    if (install.type !== "github") throw new Error("rust-analyzer test fixture must use github install");

    expect(resolveGithubAssetName(install, undefined)).toBe(`rust-analyzer-${getGithubPlatformToken()}.gz`);
  });

  it("resolves direct Eclipse JDT LS download URLs for the pinned stable build", () => {
    const install = BUILTIN_CATALOG.servers.jdtls.install;
    if (install.type !== "github") throw new Error("jdtls test fixture must use github install");

    const asset = resolveGithubAssetName(install, undefined);

    expect(asset).toBe("jdt-language-server-1.58.0-202604151538.tar.gz");
    expect(buildGithubAssetUrl(install, asset, install.version)).toBe(
      "https://download.eclipse.org/jdtls/milestones/1.58.0/jdt-language-server-1.58.0-202604151538.tar.gz",
    );
  });

  it("normalizes raw GitHub executable assets to the configured binary name", async () => {
    const result = await installServerBackend(BUILTIN_CATALOG.servers["rust-analyzer"], undefined, {
      now: new Date("2026-05-28T00:00:00.000Z"),
      env: { PATH: "" },
      downloadFile: async (_url, destinationPath) => {
        await writeFile(destinationPath, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(destinationPath, 0o755);
      },
    });

    expect(result.metadata).toMatchObject({
      installer: "github",
      resolvedCommand: [join(getBinDir(), "rust-analyzer")],
      packageDir: join(getPackagesDir(), "rust-analyzer"),
      binDir: getBinDir(),
    });
    await expect(readFile(join(getPackagesDir(), "rust-analyzer", "rust-analyzer"), "utf8")).resolves.toContain(
      "#!/bin/sh",
    );
    await expect(readFile(join(getBinDir(), "rust-analyzer"), "utf8")).resolves.toContain("#!/bin/sh");
  });

  it("fails GitHub archive installs when the expected binary is missing", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers["rust-analyzer"],
      install: {
        type: "github",
        repo: "example/example",
        asset: "server.tar.gz",
        bin: "server",
      },
      command: ["{installBin}/server"],
    };

    await expect(
      installServerBackend(server, undefined, {
        env: { PATH: "" },
        downloadFile: async (_url, destinationPath) => {
          await writeFile(destinationPath, "archive", "utf8");
        },
        runner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      }),
    ).rejects.toThrow("binary not found");
  });

  it("records deterministic JDT LS package metadata without requiring a managed shim", async () => {
    const result = await installServerBackend(BUILTIN_CATALOG.servers.jdtls, undefined, {
      now: new Date("2026-05-28T00:00:00.000Z"),
      env: { PATH: "" },
      downloadFile: async (_url, destinationPath) => {
        await writeFile(destinationPath, "archive", "utf8");
      },
      runner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    });

    expect(result.metadata).toEqual({
      installer: "github",
      requestedVersion: "1.58.0",
      resolvedCommand: BUILTIN_CATALOG.servers.jdtls.command,
      packageDir: join(getPackagesDir(), "jdtls"),
      installedAt: "2026-05-28T00:00:00.000Z",
    });
  });

  it("resolves system installer commands through PATH", async () => {
    const binDir = join(tempHome, "system-bin");
    const executable = join(binDir, "pyright-langserver");
    await mkdir(binDir, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      install: { type: "system", command: ["pyright-langserver", "--stdio"] },
    };

    const install = server.install;
    if (install.type !== "system") throw new Error("system test fixture must use system install");

    await expect(resolveSystemCommand(server, install, { PATH: binDir })).resolves.toEqual([executable, "--stdio"]);
  });
});

describe("LspInstallManager", () => {
  it("uses an existing lockfile entry without reinstalling", async () => {
    const metadata = metadataFor("pyright", "npm");
    await writeLockfile({ servers: { pyright: metadata } });
    let installs = 0;

    const manager = new LspInstallManager({
      catalog: BUILTIN_CATALOG,
      installMode: "auto",
      backendInstaller: async () => {
        installs += 1;
        return { metadata: metadataFor("pyright", "npm"), logPath: join(getLogsDir(), "pyright-install.log") };
      },
    });

    await expect(manager.ensureInstalled("pyright")).resolves.toEqual({
      status: "installed",
      serverId: "pyright",
      metadata,
      installedNow: false,
    });
    expect(installs).toBe(0);
  });

  it("does not auto-install or overwrite corrupt lockfiles", async () => {
    await mkdir(dirname(getLockfilePath()), { recursive: true });
    await writeFile(getLockfilePath(), "{not-json", "utf8");
    let installs = 0;

    const manager = new LspInstallManager({
      catalog: BUILTIN_CATALOG,
      installMode: "auto",
      backendInstaller: async () => {
        installs += 1;
        return { metadata: metadataFor("pyright", "npm"), logPath: join(getLogsDir(), "pyright-install.log") };
      },
    });

    await expect(manager.ensureInstalled("pyright")).rejects.toThrow("Invalid LSP lockfile");
    expect(installs).toBe(0);
    await expect(readFile(getLockfilePath(), "utf8")).resolves.toBe("{not-json");
  });

  it("reports the exact install command when installMode is off or prompt has no confirmer", async () => {
    const offManager = new LspInstallManager({ catalog: BUILTIN_CATALOG, installMode: "off" });
    await expect(offManager.ensureInstalled("pyright")).resolves.toMatchObject({
      status: "missing",
      installCommand: "/lsp install pyright",
    });

    const promptManager = new LspInstallManager({ catalog: BUILTIN_CATALOG, installMode: "prompt" });
    await expect(promptManager.ensureInstalled("pyright", "1.1.405")).resolves.toMatchObject({
      status: "missing",
      installCommand: "/lsp install pyright@1.1.405",
    });
    expect(formatInstallCommand("pyright", "1.1.405")).toBe("/lsp install pyright@1.1.405");
  });

  it("installs after a prompt confirmer accepts", async () => {
    const metadata = metadataFor("pyright", "npm");
    const manager = new LspInstallManager({
      catalog: BUILTIN_CATALOG,
      installMode: "prompt",
      confirmer: async ({ command }) => command === "/lsp install pyright",
      backendInstaller: async () => ({ metadata, logPath: join(getLogsDir(), "pyright-install.log") }),
    });

    await expect(manager.ensureInstalled("pyright")).resolves.toEqual({
      status: "installed",
      serverId: "pyright",
      metadata,
      installedNow: true,
    });
    await expect(readLockfile()).resolves.toEqual({ servers: { pyright: metadata } });
  });

  it("leaves the lockfile unchanged when install fails", async () => {
    const existing = metadataFor("pyright", "npm");
    await writeLockfile({ servers: { pyright: existing } });
    const manager = new LspInstallManager({
      catalog: BUILTIN_CATALOG,
      installMode: "auto",
      backendInstaller: async () => {
        throw new Error("simulated install failure");
      },
    });

    await expect(manager.installServer("pyright", "1.1.406")).rejects.toThrow("simulated install failure");
    await expect(readLockfile()).resolves.toEqual({ servers: { pyright: existing } });
  });

  it("uninstalls lockfile entries, package directories, and managed shims", async () => {
    const metadata = metadataFor("pyright", "npm");
    await writeLockfile({ servers: { pyright: metadata } });
    await mkdir(join(getPackagesDir(), "pyright"), { recursive: true });
    await mkdir(getBinDir(), { recursive: true });
    await writeFile(join(getBinDir(), "pyright-langserver"), "shim", "utf8");

    const manager = new LspInstallManager({ catalog: BUILTIN_CATALOG, installMode: "auto" });

    await expect(manager.uninstallServer("pyright")).resolves.toEqual({ serverId: "pyright", removed: true });
    await expect(readLockfile()).resolves.toEqual({ servers: {} });
    await expect(readFile(join(getBinDir(), "pyright-langserver"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(getPackagesDir(), "pyright"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs at most one install concurrently", async () => {
    let activeInstalls = 0;
    let maxActiveInstalls = 0;
    const started: string[] = [];
    const backendInstaller: BackendInstaller = async (server) => {
      started.push(server.id);
      activeInstalls += 1;
      maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
      await delay(10);
      activeInstalls -= 1;
      return {
        metadata: metadataFor(server.id, server.install.type),
        logPath: join(getLogsDir(), `${server.id}-install.log`),
      };
    };

    const manager = new LspInstallManager({ catalog: BUILTIN_CATALOG, installMode: "auto", backendInstaller });

    await Promise.all([manager.installServer("pyright"), manager.installServer("vtsls")]);

    expect(started).toEqual(["pyright", "vtsls"]);
    expect(maxActiveInstalls).toBe(1);
    const lockfile = await readLockfile();
    expect(Object.keys(lockfile.servers).sort()).toEqual(["pyright", "vtsls"]);
  });
});

async function createNpmBin(args: string[], binName: string): Promise<void> {
  const prefix = args[args.indexOf("--prefix") + 1];
  if (!prefix) throw new Error("test npm invocation did not include --prefix");
  await createExecutable(join(prefix, "node_modules", ".bin", binName));
}

async function createExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

function metadataFor(serverId: string, installer: InstalledServerMetadata["installer"]): InstalledServerMetadata {
  return createInstalledServerMetadata({
    installer,
    resolvedCommand: [join(getBinDir(), serverId)],
    installedAt: new Date("2026-05-28T00:00:00.000Z"),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
