import { readdir } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isPlainObject, normalizeProcessEnv } from "../util/helpers.js";
import { applyLanguageDefaults } from "./languages.js";
import type {
  InstalledServerMetadata,
  JsonObject,
  JsonValue,
  ResolvedServerConfig,
  ServerDefinition,
} from "../registry/schema.js";
import { deepClone } from "../util/deepMerge.js";
import { ConfigError, MissingEnvironmentVariableError } from "../util/errors.js";

export interface ResolveServerConfigInput {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  install?: InstalledServerMetadata;
  processEnv?: NodeJS.ProcessEnv;
}

export async function resolveServerConfig(input: ResolveServerConfigInput): Promise<ResolvedServerConfig> {
  const rootDir = resolve(input.rootDir);
  const processEnv = normalizeProcessEnv(input.processEnv ?? process.env);
  const env = resolveServerEnv(input.server.env ?? {}, processEnv, rootDir);
  const settings = resolveJsonObject(input.server.settings, { env, rootDir, fieldPath: "settings" });
  const initializationOptions = resolveJsonObject(input.server.initializationOptions, {
    env,
    rootDir,
    fieldPath: "initializationOptions",
  });
  const cwd = resolvePathString(expandEnvReferences(input.server.cwd ?? rootDir, env, "cwd"), rootDir, env);

  const languageDefaults = await applyLanguageDefaults({
    server: input.server,
    rootDir,
    env,
    settings,
    initializationOptions,
  });

  const command = await resolveCommand(input.server.command, {
    env: languageDefaults.env,
    rootDir,
    install: input.install,
    workspaceDir: languageDefaults.workspaceDir,
  });

  return {
    server: input.server,
    rootDir,
    rootMarker: input.rootMarker,
    command,
    cwd,
    env: languageDefaults.env,
    settings: languageDefaults.settings,
    initializationOptions: languageDefaults.initializationOptions,
    install: input.install,
  };
}

interface ResolutionContext {
  env: Record<string, string>;
  rootDir: string;
  fieldPath: string;
}

interface CommandResolutionContext {
  env: Record<string, string>;
  rootDir: string;
  install?: InstalledServerMetadata;
  workspaceDir?: string;
}

function resolveServerEnv(
  serverEnv: Record<string, string>,
  processEnv: Record<string, string>,
  rootDir: string,
): Record<string, string> {
  const env = { ...processEnv };
  const resolvedOverrides: Record<string, string> = {};
  const resolving = new Set<string>();

  const resolveOverride = (key: string): string => {
    const cached = resolvedOverrides[key];
    if (cached !== undefined) return cached;

    const rawValue = serverEnv[key];
    if (rawValue === undefined) {
      const processValue = processEnv[key];
      if (processValue !== undefined) return processValue;
      throw new MissingEnvironmentVariableError(key);
    }

    if (resolving.has(key)) {
      const fallback = processEnv[key];
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`Circular environment variable reference involving ${key}.`);
    }

    resolving.add(key);
    const interpolated = expandEnvReferences(rawValue, env, `env.${key}`, (variableName) => {
      if (variableName === key) {
        const fallback = processEnv[variableName];
        if (fallback !== undefined) return fallback;
      }

      if (Object.prototype.hasOwnProperty.call(serverEnv, variableName)) {
        return resolveOverride(variableName);
      }

      return env[variableName];
    });
    resolving.delete(key);

    const resolved = isPathLikeEnvKey(key) ? resolvePathList(interpolated, rootDir, env) : interpolated;
    resolvedOverrides[key] = resolved;
    env[key] = resolved;
    return resolved;
  };

  for (const key of Object.keys(serverEnv)) {
    resolveOverride(key);
  }

  return env;
}

function resolveJsonObject(value: JsonObject, context: ResolutionContext): JsonObject {
  return resolveJsonValue(deepClone(value), context) as JsonObject;
}

function resolveJsonValue(value: JsonValue, context: ResolutionContext): JsonValue {
  if (typeof value === "string") {
    const interpolated = expandEnvReferences(value, context.env, context.fieldPath);
    return isPathLikeField(context.fieldPath)
      ? resolvePathString(interpolated, context.rootDir, context.env)
      : interpolated;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveJsonValue(entry, { ...context, fieldPath: `${context.fieldPath}[${index}]` }),
    );
  }

  if (isPlainObject(value)) {
    const resolved: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${context.fieldPath}.${key}`;
      resolved[key] = resolveJsonValue(entry, { ...context, fieldPath: childPath });
    }
    return resolved;
  }

  return value;
}

async function resolveCommand(command: string[], context: CommandResolutionContext): Promise<string[]> {
  const placeholders: Record<string, string | undefined> = {
    installBin: getInstallBinDir(context.install),
    installDir: getInstallDir(context.install),
    platform: getPlatformToken(),
    workspaceDir: context.workspaceDir,
  };

  const resolved: string[] = [];
  for (const [index, part] of command.entries()) {
    const field = `command[${index}]`;
    const withTemplates = replaceCommandPlaceholders(part, placeholders);
    if (containsUnresolvedPlaceholder(withTemplates)) {
      throw new ConfigError(`Unresolved placeholder in ${field}: ${withTemplates}`);
    }

    const interpolated = expandEnvReferences(withTemplates, context.env, field);
    const expanded = expandTilde(interpolated, context.env);
    const pathResolved = shouldResolveCommandPart(expanded)
      ? resolvePathString(expanded, context.rootDir, context.env)
      : expanded;
    resolved.push(await resolveWildcardPath(pathResolved, field));
  }

  return resolved;
}

function replaceCommandPlaceholders(value: string, placeholders: Record<string, string | undefined>): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name: string) => placeholders[name] ?? match);
}

function getInstallBinDir(install: InstalledServerMetadata | undefined): string | undefined {
  if (install?.binDir) return install.binDir;
  const commandPath = install?.resolvedCommand[0];
  if (!commandPath || !commandPath.includes("/")) return undefined;
  return dirname(commandPath);
}

function getInstallDir(install: InstalledServerMetadata | undefined): string | undefined {
  if (install?.packageDir) return install.packageDir;
  const binDir = getInstallBinDir(install);
  if (!binDir) return undefined;
  return dirname(binDir);
}

function containsUnresolvedPlaceholder(value: string): boolean {
  return /\{[A-Za-z][A-Za-z0-9]*\}/u.test(value);
}

async function resolveWildcardPath(value: string, field: string): Promise<string> {
  if (!value.includes("*")) return value;

  const filename = basename(value);
  if (filename !== "org.eclipse.equinox.launcher_*.jar") {
    throw new ConfigError(`Unsupported wildcard in ${field}: ${value}`);
  }

  const directory = dirname(value);
  const matches = (await readdir(directory))
    .filter((entry) => entry.startsWith("org.eclipse.equinox.launcher_") && entry.endsWith(".jar"))
    .sort();
  const match = matches.at(-1);
  if (!match) {
    throw new ConfigError(`No JDT LS launcher jar found in ${directory}.`);
  }
  return join(directory, match);
}

function getPlatformToken(): string {
  return `${process.platform}-${process.arch}`;
}

function expandEnvReferences(
  value: string,
  env: Record<string, string>,
  field: string,
  resolveVariable: (variableName: string) => string | undefined = (variableName) => env[variableName],
): string {
  return value.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, variableName: string) => {
    const replacement = resolveVariable(variableName);
    if (replacement === undefined) {
      throw new MissingEnvironmentVariableError(variableName, field);
    }
    return replacement;
  });
}

function resolvePathList(value: string, rootDir: string, env: Record<string, string>): string {
  if (!value.includes(delimiter)) {
    return resolvePathString(value, rootDir, env);
  }

  return value
    .split(delimiter)
    .map((entry) => (entry === "" ? entry : resolvePathString(entry, rootDir, env)))
    .join(delimiter);
}

function resolvePathString(value: string, rootDir: string, env: Record<string, string>): string {
  const expanded = expandTilde(value, env);
  if (expanded === "") return expanded;
  if (isAbsolute(expanded)) return expanded;
  return resolve(rootDir, expanded);
}

function expandTilde(value: string, env: Record<string, string>): string {
  if (value === "~") return getHomeDir(env);
  if (value.startsWith(`~${getPathSeparator(value)}`)) {
    return join(getHomeDir(env), value.slice(2));
  }
  return value;
}

function getPathSeparator(value: string): "/" | "\\" {
  return value.startsWith("~\\") ? "\\" : "/";
}

function getHomeDir(env: Record<string, string>): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function shouldResolveCommandPart(value: string): boolean {
  if (value === "" || value.startsWith("-")) return false;
  return value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\");
}

function isPathLikeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "PATH" ||
    upper.endsWith("PATH") ||
    upper.endsWith("_DIR") ||
    upper.endsWith("_HOME") ||
    upper.endsWith("ROOT") ||
    upper.includes("CACHE")
  );
}

function isPathLikeField(fieldPath: string): boolean {
  const key =
    fieldPath
      .replace(/\[[0-9]+\]$/u, "")
      .split(".")
      .at(-1)
      ?.toLowerCase() ?? "";
  return (
    key.includes("path") ||
    key.endsWith("dir") ||
    key.endsWith("directory") ||
    key.endsWith("folder") ||
    key.endsWith("file") ||
    key.endsWith("root") ||
    key.includes("workspace")
  );
}
