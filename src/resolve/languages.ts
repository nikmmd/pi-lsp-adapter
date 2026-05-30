import { delimiter, join, resolve } from "node:path";
import { getWorkspacesDir } from "../config/paths.js";
import type { JsonObject, ServerDefinition } from "../registry/schema.js";
import { deepClone } from "../util/deepMerge.js";
import { hashPath } from "../util/hash.js";
import { isPythonServerId, pathExists } from "../util/helpers.js";

export interface LanguageDefaultsInput {
  server: ServerDefinition;
  rootDir: string;
  env: Record<string, string>;
  settings: JsonObject;
  initializationOptions: JsonObject;
}

export interface LanguageDefaultsResult {
  env: Record<string, string>;
  settings: JsonObject;
  initializationOptions: JsonObject;
  workspaceDir?: string;
}

export async function applyLanguageDefaults(input: LanguageDefaultsInput): Promise<LanguageDefaultsResult> {
  const env = { ...input.env };
  const settings = deepClone(input.settings);
  const initializationOptions = deepClone(input.initializationOptions);
  let workspaceDir: string | undefined;

  if (isPythonServer(input.server)) {
    await applyPythonDefaults(input.rootDir, env, settings);
  }

  if (input.server.id === "jdtls") {
    workspaceDir = join(getWorkspacesDir(), "jdtls", hashPath(input.rootDir));
  }

  return { env, settings, initializationOptions, workspaceDir };
}

async function applyPythonDefaults(rootDir: string, env: Record<string, string>, settings: JsonObject): Promise<void> {
  const venvDir = await selectPythonVirtualEnv(rootDir, env);
  if (!venvDir) return;

  const binDir = getVirtualEnvBinDir(venvDir);
  env.PATH = prependPath(binDir, env.PATH ?? "");

  if (!hasPythonInterpreterSetting(settings)) {
    settings["python.defaultInterpreterPath"] = join(binDir, getPythonExecutableName());
  }
}

async function selectPythonVirtualEnv(rootDir: string, env: Record<string, string>): Promise<string | undefined> {
  if (env.VIRTUAL_ENV) {
    return resolve(rootDir, env.VIRTUAL_ENV);
  }

  for (const dirname of [".venv", "venv"]) {
    const candidate = join(rootDir, dirname);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isPythonServer(server: ServerDefinition): boolean {
  return isPythonServerId(server.id) || server.filetypes.includes("python");
}

function getVirtualEnvBinDir(venvDir: string): string {
  return join(venvDir, process.platform === "win32" ? "Scripts" : "bin");
}

function getPythonExecutableName(): string {
  return process.platform === "win32" ? "python.exe" : "python";
}

function prependPath(path: string, currentPath: string): string {
  if (!currentPath) return path;
  return `${path}${delimiter}${currentPath}`;
}

function hasPythonInterpreterSetting(settings: JsonObject): boolean {
  if (typeof settings["python.defaultInterpreterPath"] === "string") {
    return true;
  }

  const python = settings.python;
  return (
    typeof python === "object" &&
    python !== null &&
    !Array.isArray(python) &&
    typeof (python as Record<string, unknown>).defaultInterpreterPath === "string"
  );
}
