import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBinDir, getPackagesDir, getWorkspacesDir } from "../../src/config/paths.js";
import { BUILTIN_CATALOG } from "../../src/registry/builtin.js";
import type { InstalledServerMetadata, ServerDefinition } from "../../src/registry/schema.js";
import { resolveServerConfig } from "../../src/resolve/resolveServer.js";
import { MissingEnvironmentVariableError } from "../../src/util/errors.js";
import { hashPath } from "../../src/util/hash.js";

let originalHome: string | undefined;
let tempHome: string;
let rootDir: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-resolver-home-"));
  rootDir = await mkdtemp(join(tmpdir(), "pi-lsp-resolver-root-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
  await rm(rootDir, { recursive: true, force: true });
});

describe("resolveServerConfig", () => {
  it("merges env, interpolates $env references, expands ~, and resolves relative path env values", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      env: {
        DJANGO_SETTINGS_MODULE: "$env:MYAPP_SETTINGS",
        PYTHONPATH: `src${delimiter}libs/shared`,
        CUSTOM_HOME: "~/custom",
      },
    };

    const resolved = await resolveServerConfig({
      server,
      rootDir,
      install: installedFor(server),
      processEnv: {
        HOME: tempHome,
        PATH: "/usr/bin",
        MYAPP_SETTINGS: "example.settings",
      },
    });

    expect(resolved.env.PATH).toBe("/usr/bin");
    expect(resolved.env.MYAPP_SETTINGS).toBe("example.settings");
    expect(resolved.env.DJANGO_SETTINGS_MODULE).toBe("example.settings");
    expect(resolved.env.PYTHONPATH).toBe([join(rootDir, "src"), join(rootDir, "libs/shared")].join(delimiter));
    expect(resolved.env.CUSTOM_HOME).toBe(join(tempHome, "custom"));
  });

  it("uses the original process value for self-referential PATH-style env overrides", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      env: {
        PATH: `$env:PATH${delimiter}tools/bin`,
        PYTHONPATH: `$env:PROJECT_LIB${delimiter}src`,
        PROJECT_LIB: "libs/project",
      },
    };

    const resolved = await resolveServerConfig({
      server,
      rootDir,
      install: installedFor(server),
      processEnv: { HOME: tempHome, PATH: "/usr/bin" },
    });

    expect(resolved.env.PATH).toBe(["/usr/bin", join(rootDir, "tools/bin")].join(delimiter));
    expect(resolved.env.PROJECT_LIB).toBe("libs/project");
    expect(resolved.env.PYTHONPATH).toBe([join(rootDir, "libs/project"), join(rootDir, "src")].join(delimiter));
  });

  it("fails clearly when an env reference is undefined", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      env: {
        DJANGO_SETTINGS_MODULE: "$env:MYAPP_SETTINGS",
      },
    };

    await expect(
      resolveServerConfig({
        server,
        rootDir,
        processEnv: { HOME: tempHome, PATH: "/usr/bin" },
      }),
    ).rejects.toThrow(MissingEnvironmentVariableError);

    await expect(
      resolveServerConfig({
        server,
        rootDir,
        processEnv: { HOME: tempHome, PATH: "/usr/bin" },
      }),
    ).rejects.toThrow("Missing environment variable MYAPP_SETTINGS referenced by env.DJANGO_SETTINGS_MODULE.");
  });

  it("resolves cwd overrides and path-like settings and initialization options", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      cwd: "services/api",
      settings: {
        "python.defaultInterpreterPath": ".venv/bin/python",
        python: {
          analysis: {
            extraPaths: ["src", "/already/absolute"],
            diagnosticMode: "workspace",
          },
        },
      },
      initializationOptions: {
        workspaceFolders: ["src", "libs/shared"],
      },
    };

    const resolved = await resolveServerConfig({
      server,
      rootDir,
      install: installedFor(server),
      processEnv: { HOME: tempHome, PATH: "/usr/bin" },
    });

    expect(resolved.cwd).toBe(join(rootDir, "services/api"));
    expect(resolved.settings["python.defaultInterpreterPath"]).toBe(join(rootDir, ".venv/bin/python"));
    expect(resolved.settings.python).toEqual({
      analysis: {
        extraPaths: [join(rootDir, "src"), "/already/absolute"],
        diagnosticMode: "workspace",
      },
    });
    expect(resolved.initializationOptions.workspaceFolders).toEqual([
      join(rootDir, "src"),
      join(rootDir, "libs/shared"),
    ]);
  });

  it("detects Python .venv and prepends its bin directory without overriding explicit interpreter settings", async () => {
    await mkdir(join(rootDir, ".venv", "bin"), { recursive: true });
    await writeFile(join(rootDir, ".venv", "bin", "python"), "", "utf8");

    const implicit = await resolveServerConfig({
      server: BUILTIN_CATALOG.servers.pyright,
      rootDir,
      install: installedFor(BUILTIN_CATALOG.servers.pyright),
      processEnv: { HOME: tempHome, PATH: "/usr/bin" },
    });

    expect(implicit.env.PATH).toBe(`${join(rootDir, ".venv", "bin")}${delimiter}/usr/bin`);
    expect(implicit.settings["python.defaultInterpreterPath"]).toBe(join(rootDir, ".venv", "bin", "python"));

    const explicitServer: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.pyright,
      settings: {
        "python.defaultInterpreterPath": "/custom/python",
      },
    };

    const explicit = await resolveServerConfig({
      server: explicitServer,
      rootDir,
      install: installedFor(explicitServer),
      processEnv: { HOME: tempHome, PATH: "/usr/bin" },
    });

    expect(explicit.settings["python.defaultInterpreterPath"]).toBe("/custom/python");
  });

  it("prefers VIRTUAL_ENV over local Python virtualenv directories", async () => {
    await mkdir(join(rootDir, ".venv", "bin"), { recursive: true });
    const externalVenv = join(tempHome, "venvs", "project");
    await mkdir(join(externalVenv, "bin"), { recursive: true });

    const resolved = await resolveServerConfig({
      server: BUILTIN_CATALOG.servers.pyright,
      rootDir,
      install: installedFor(BUILTIN_CATALOG.servers.pyright),
      processEnv: { HOME: tempHome, PATH: "/usr/bin", VIRTUAL_ENV: externalVenv },
    });

    expect(resolved.env.PATH).toBe(`${join(externalVenv, "bin")}${delimiter}/usr/bin`);
    expect(resolved.settings["python.defaultInterpreterPath"]).toBe(join(externalVenv, "bin", "python"));
  });

  it("resolves JDT LS install, platform, launcher wildcard, and workspace placeholders", async () => {
    const packageDir = join(getPackagesDir(), "jdtls");
    await mkdir(join(packageDir, "plugins"), { recursive: true });
    await writeFile(join(packageDir, "plugins", "org.eclipse.equinox.launcher_1.2.3.jar"), "jar", "utf8");

    const resolved = await resolveServerConfig({
      server: BUILTIN_CATALOG.servers.jdtls,
      rootDir,
      install: {
        installer: "github",
        requestedVersion: "1.49.0",
        resolvedCommand: BUILTIN_CATALOG.servers.jdtls.command,
        packageDir,
        installedAt: "2026-05-28T00:00:00Z",
      },
      processEnv: { HOME: tempHome, PATH: "/usr/bin", JAVA_HOME: "/opt/java" },
    });

    const expectedWorkspace = join(getWorkspacesDir(), "jdtls", hashPath(rootDir));
    expect(resolved.command).toContain(expectedWorkspace);
    expect(resolved.command).toContain(join(packageDir, "plugins", "org.eclipse.equinox.launcher_1.2.3.jar"));
    expect(resolved.command).toContain(join(packageDir, `config_${process.platform}-${process.arch}`));
    expect(resolved.command.join(" ")).not.toMatch(/[{}*]/u);
    expect(resolved.env.JAVA_HOME).toBe("/opt/java");
  });

  it("preserves Go and Rust process environment variables", async () => {
    const processEnv = {
      HOME: tempHome,
      PATH: "/usr/bin",
      GOPATH: "/go/path",
      GOMODCACHE: "/go/cache",
      GOROOT: "/go/root",
      CARGO_HOME: "/cargo/home",
      RUSTUP_HOME: "/rustup/home",
      RUSTFLAGS: "-Dwarnings",
    };

    const go = await resolveServerConfig({
      server: BUILTIN_CATALOG.servers.gopls,
      rootDir,
      install: installedFor(BUILTIN_CATALOG.servers.gopls),
      processEnv,
    });
    const rust = await resolveServerConfig({
      server: BUILTIN_CATALOG.servers["rust-analyzer"],
      rootDir,
      install: installedFor(BUILTIN_CATALOG.servers["rust-analyzer"]),
      processEnv,
    });

    expect(go.env).toMatchObject({ GOPATH: "/go/path", GOMODCACHE: "/go/cache", GOROOT: "/go/root" });
    expect(rust.env).toMatchObject({ CARGO_HOME: "/cargo/home", RUSTUP_HOME: "/rustup/home", RUSTFLAGS: "-Dwarnings" });
  });

  it("expands install and environment placeholders in command argv without using a shell", async () => {
    const server: ServerDefinition = {
      ...BUILTIN_CATALOG.servers.vtsls,
      command: ["{installBin}/vtsls", "--tsdk", "$env:TSDK"],
    };

    const resolved = await resolveServerConfig({
      server,
      rootDir,
      install: {
        installer: "npm",
        packages: { "@vtsls/language-server": "0.2.9" },
        resolvedCommand: ["/tmp/pi-lsp/bin/vtsls", "--stdio"],
        installedAt: "2026-05-28T00:00:00Z",
      },
      processEnv: { HOME: tempHome, PATH: "/usr/bin", TSDK: resolve(rootDir, "typescript/lib") },
    });

    expect(resolved.command).toEqual(["/tmp/pi-lsp/bin/vtsls", "--tsdk", resolve(rootDir, "typescript/lib")]);
  });
});

function installedFor(server: ServerDefinition): InstalledServerMetadata {
  const binName = server.install.type === "system" ? server.id : server.install.bin;
  return {
    installer: server.install.type,
    resolvedCommand: [join(getBinDir(), binName)],
    binDir: getBinDir(),
    installedAt: "2026-05-28T00:00:00Z",
  };
}
