import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLspConfig } from "../../src/config/loadConfig.js";
import {
  getBinDir,
  getCacheDir,
  getLockfilePath,
  getLogsDir,
  getManagedLspRoot,
  getPackagesDir,
  getProcessRegistryDir,
  getProcessRegistryPath,
  getProjectConfigPath,
  getRegistryDir,
  getTrustStorePath,
  getUserConfigPath,
  getWorkspacesDir,
} from "../../src/config/paths.js";
import { isProjectTrusted, loadTrustStore, trustProject, untrustProject } from "../../src/config/trust.js";

let originalHome: string | undefined;
let tempHome: string;
let projectRoot: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-home-"));
  projectRoot = await mkdtemp(join(tmpdir(), "pi-lsp-project-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(tempHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe("config paths", () => {
  it("uses the managed root under ~/.pi/agent/lsp and the user override path under ~/.pi/agent/lsp.json", () => {
    expect(getManagedLspRoot()).toBe(join(tempHome, ".pi", "agent", "lsp"));
    expect(getRegistryDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "registry"));
    expect(getPackagesDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "packages"));
    expect(getBinDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "bin"));
    expect(getCacheDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "cache"));
    expect(getLogsDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "logs"));
    expect(getLockfilePath()).toBe(join(tempHome, ".pi", "agent", "lsp", "lsp.lock.json"));
    expect(getWorkspacesDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "workspaces"));
    expect(getProcessRegistryDir()).toBe(join(tempHome, ".pi", "agent", "lsp", "pids"));
    expect(getProcessRegistryPath("pi-lsp-123:repo/path")).toBe(
      join(tempHome, ".pi", "agent", "lsp", "pids", "pi-lsp-123_repo_path.json"),
    );
    expect(getTrustStorePath()).toBe(join(tempHome, ".pi", "agent", "lsp", "trust.json"));
    expect(getUserConfigPath()).toBe(join(tempHome, ".pi", "agent", "lsp.json"));
    expect(getProjectConfigPath(projectRoot)).toBe(join(projectRoot, ".pi", "lsp.json"));
  });
});

describe("trust store", () => {
  it("trusts and untrusts canonical project roots", async () => {
    const realProject = join(projectRoot, "real");
    const linkedProject = join(projectRoot, "linked");
    await mkdir(realProject, { recursive: true });
    await symlink(realProject, linkedProject, "dir");

    await trustProject(linkedProject);

    expect(await isProjectTrusted(realProject)).toBe(true);
    const store = await loadTrustStore();
    expect(store.trustedProjects).toEqual([realProject]);

    const trustJson = JSON.parse(await readFile(getTrustStorePath(), "utf8")) as { trustedProjects: string[] };
    expect(trustJson.trustedProjects).toEqual([realProject]);

    await untrustProject(realProject);

    expect(await isProjectTrusted(linkedProject)).toBe(false);
    expect(await loadTrustStore()).toEqual({ trustedProjects: [] });
  });
});

describe("loadLspConfig", () => {
  it("defaults warmup to enabled and lets global config disable it", async () => {
    expect((await loadLspConfig({ cwd: projectRoot, projectRoot })).warmup).toBe(true);

    await writeJson(getUserConfigPath(), { warmup: false });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.warmup).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("treats project warmup overrides as trusted-only", async () => {
    await writeJson(getUserConfigPath(), { warmup: false });
    await writeJson(getProjectConfigPath(projectRoot), { warmup: true });

    const untrusted = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(untrusted.warmup).toBe(false);
    expect(untrusted.warnings).toEqual([expect.stringContaining("trusted-only project warmup")]);

    await trustProject(projectRoot);

    const trusted = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(trusted.warmup).toBe(true);
    expect(trusted.warnings).toEqual([]);
  });

  it("ignores invalid warmup values", async () => {
    await writeJson(getUserConfigPath(), { warmup: "yes" });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.warmup).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining("Ignoring invalid warmup")]);
  });

  it("merges config layers as built-in < global < project and preserves partial safe overrides", async () => {
    await writeJson(getUserConfigPath(), {
      installMode: "auto",
      servers: {
        pyright: {
          env: { GLOBAL_ONLY: "1", SHARED: "global" },
          install: { packages: { pyright: "1.1.406" } },
          settings: { python: { analysis: { typeCheckingMode: "strict" } } },
        },
      },
    });
    await writeJson(getProjectConfigPath(projectRoot), {
      servers: {
        pyright: {
          cwd: "services/api",
          env: { PROJECT_ONLY: "2", SHARED: "project" },
          filetypes: ["python", "python-stub"],
          settings: { python: { analysis: { extraPaths: ["src"] } } },
        },
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.warnings).toEqual([]);
    expect(result.installMode).toBe("auto");
    expect(result.catalog.servers.pyright.filetypes).toEqual(["python", "python-stub"]);
    expect(result.catalog.servers.pyright.command).toEqual(["{installBin}/pyright-langserver", "--stdio"]);
    expect(result.catalog.servers.pyright.cwd).toBe("services/api");
    expect(result.catalog.servers.pyright.install).toEqual({
      type: "npm",
      packages: { pyright: "1.1.406" },
      bin: "pyright-langserver",
    });
    expect(result.catalog.servers.pyright.env).toEqual({
      GLOBAL_ONLY: "1",
      PROJECT_ONLY: "2",
      SHARED: "project",
    });
    expect(result.catalog.servers.pyright.settings).toEqual({
      python: {
        analysis: {
          typeCheckingMode: "strict",
          extraPaths: ["src"],
        },
      },
    });
  });

  it("restricts untrusted project config to safe server fields and ignores project installMode", async () => {
    await writeJson(getProjectConfigPath(projectRoot), {
      installMode: "auto",
      servers: {
        pyright: {
          id: "evil-pyright",
          displayName: "Evil Pyright",
          lazy: false,
          command: ["/tmp/evil", "--stdio"],
          install: {
            type: "npm",
            packages: { pyright: "9.9.9", "evil-package": "1.0.0" },
            bin: "evil-pyright",
          },
          cwd: "services/api",
          env: {
            DJANGO_SETTINGS_MODULE: "example.settings",
            PATH: "/tmp/evil-bin",
            NODE_OPTIONS: "--require /tmp/evil.js",
          },
          filetypes: ["python", "python-stub"],
          rootMarkers: ["custom.marker", ".git"],
          settings: { python: { analysis: { diagnosticMode: "workspace" } } },
          initializationOptions: { python: { analysis: { useLibraryCodeForTypes: true } } },
        },
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.installMode).toBe("prompt");
    expect(result.catalog.servers.pyright.id).toBe("pyright");
    expect(result.catalog.servers.pyright.displayName).toBe("Pyright");
    expect(result.catalog.servers.pyright.lazy).toBe(true);
    expect(result.catalog.servers.pyright.command).toEqual(["{installBin}/pyright-langserver", "--stdio"]);
    expect(result.catalog.servers.pyright.install).toEqual({
      type: "npm",
      packages: { pyright: "1.1.410" },
      bin: "pyright-langserver",
    });
    expect(result.catalog.servers.pyright.cwd).toBe("services/api");
    expect(result.catalog.servers.pyright.env).toEqual({ DJANGO_SETTINGS_MODULE: "example.settings" });
    expect(result.catalog.servers.pyright.filetypes).toEqual(["python", "python-stub"]);
    expect(result.catalog.servers.pyright.rootMarkers).toEqual(["custom.marker", ".git"]);
    expect(result.catalog.servers.pyright.settings).toEqual({
      python: { analysis: { diagnosticMode: "workspace" } },
    });
    expect(result.catalog.servers.pyright.initializationOptions).toEqual({
      python: { analysis: { useLibraryCodeForTypes: true } },
    });
    expect(result.warnings).toHaveLength(8);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("trusted-only project installMode"),
        expect.stringContaining("pyright.id"),
        expect.stringContaining("pyright.displayName"),
        expect.stringContaining("pyright.lazy"),
        expect.stringContaining("pyright.command"),
        expect.stringContaining("package names, and package versions"),
        expect.stringContaining("pyright.PATH"),
        expect.stringContaining("pyright.NODE_OPTIONS"),
      ]),
    );
  });

  it("infers the runtime command from explicit system install command overrides", async () => {
    await writeJson(getUserConfigPath(), {
      servers: {
        pyright: {
          install: {
            type: "system",
            command: ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"],
          },
        },
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.warnings).toEqual([]);
    expect(result.catalog.servers.pyright.install).toEqual({
      type: "system",
      command: ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"],
    });
    expect(result.catalog.servers.pyright.command).toEqual([
      "~/.local/share/nvim/mason/bin/pyright-langserver",
      "--stdio",
    ]);
  });

  it("allows trusted project config to override installMode and executable fields while keeping catalog key ids authoritative", async () => {
    await trustProject(projectRoot);
    await writeJson(getProjectConfigPath(projectRoot), {
      installMode: "off",
      servers: {
        pyright: {
          id: "trusted-pyright",
          displayName: "Trusted Pyright",
          lazy: false,
          command: ["pyright-langserver", "--stdio"],
          install: { type: "system", command: ["pyright-langserver", "--stdio"] },
        },
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.warnings).toEqual([expect.stringContaining("catalog keys are authoritative")]);
    expect(result.installMode).toBe("off");
    expect(result.catalog.servers.pyright.id).toBe("pyright");
    expect(result.catalog.servers.pyright.displayName).toBe("Trusted Pyright");
    expect(result.catalog.servers.pyright.lazy).toBe(false);
    expect(result.catalog.servers.pyright.command).toEqual(["pyright-langserver", "--stdio"]);
    expect(result.catalog.servers.pyright.install).toEqual({
      type: "system",
      command: ["pyright-langserver", "--stdio"],
    });
  });

  it("rejects untrusted cwd paths outside the project root and process-affecting env for non-Python servers", async () => {
    await writeJson(getProjectConfigPath(projectRoot), {
      servers: {
        jdtls: {
          cwd: "../outside",
          env: {
            PATH: "/tmp/evil-bin",
            PYTHONPATH: "java-hook",
            SAFE_FLAG: "kept",
          },
        },
        pyright: {
          cwd: "/tmp/absolute",
          env: {
            PYTHONPATH: "src",
          },
        },
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.catalog.servers.jdtls.cwd).toBeUndefined();
    expect(result.catalog.servers.jdtls.env).toEqual({ SAFE_FLAG: "kept" });
    expect(result.catalog.servers.pyright.cwd).toBeUndefined();
    expect(result.catalog.servers.pyright.env).toEqual({ PYTHONPATH: "src" });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("jdtls.PATH"),
        expect.stringContaining("jdtls.PYTHONPATH"),
        expect.stringContaining("cwd must stay inside"),
        expect.stringContaining("cwd must be relative"),
      ]),
    );
  });

  it("reports bad config without throwing and keeps the previous valid server definition", async () => {
    await mkdir(dirname(getUserConfigPath()), { recursive: true });
    await writeFile(getUserConfigPath(), "{not-json", "utf8");
    await trustProject(projectRoot);
    await writeJson(getProjectConfigPath(projectRoot), {
      installMode: "sometimes",
      servers: {
        pyright: { filetypes: "python" },
        gopls: null,
      },
    });

    const result = await loadLspConfig({ cwd: projectRoot, projectRoot });

    expect(result.installMode).toBe("prompt");
    expect(result.catalog.servers.pyright.filetypes).toEqual(["python"]);
    expect(result.catalog.servers.gopls.filetypes).toEqual(["go"]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Could not parse global config"),
      expect.stringContaining("Ignoring invalid installMode"),
      expect.stringContaining("Ignoring invalid pyright server definition"),
      expect.stringContaining("gopls"),
    ]);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
