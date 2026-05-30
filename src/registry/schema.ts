import { Type } from "typebox";
import { Value } from "typebox/value";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type InstallMode = "prompt" | "auto" | "off";

export const SUPPORTED_LANGUAGE_SERVER_IDS = [
  "vtsls",
  "pyright",
  "gopls",
  "rust-analyzer",
  "yamlls",
  "jsonls",
  "jdtls",
] as const;

export type SupportedLanguageServerId = (typeof SUPPORTED_LANGUAGE_SERVER_IDS)[number];

export type InstallerType = "npm" | "go" | "github" | "system";

export interface BaseInstallSpec {
  type: InstallerType;
}

export interface NpmInstallSpec extends BaseInstallSpec {
  type: "npm";
  packages: Record<string, string>;
  bin: string;
}

export interface GoInstallSpec extends BaseInstallSpec {
  type: "go";
  module: string;
  version?: string;
  bin: string;
}

export interface GithubInstallSpec extends BaseInstallSpec {
  type: "github";
  repo: string;
  version?: string;
  asset?: string;
  downloadUrl?: string;
  bin: string;
  stripComponents?: number;
}

export interface SystemInstallSpec extends BaseInstallSpec {
  type: "system";
  bin?: string;
  command?: string[];
}

export type InstallSpec = NpmInstallSpec | GoInstallSpec | GithubInstallSpec | SystemInstallSpec;

export interface ServerDefinition<TServerId extends string = string> {
  id: TServerId;
  displayName: string;
  filetypes: string[];
  rootMarkers: string[];
  install: InstallSpec;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  settings: JsonObject;
  initializationOptions: JsonObject;
  lazy: boolean;
}

export interface Catalog<TServerId extends string = string> {
  servers: { [ServerId in TServerId]: ServerDefinition<ServerId> };
}

export type RuntimeCatalog = Catalog<string>;
export type BuiltinCatalog = Catalog<SupportedLanguageServerId>;

export interface FiletypeRules {
  exactFilenames?: Record<string, string>;
  extensions?: Record<string, string>;
}

export interface LspConfig {
  installMode?: InstallMode;
  warmup?: boolean;
  servers?: Record<string, Partial<ServerDefinition>>;
  trustedProjects?: string[];
}

export interface InstalledServerMetadata {
  installer: InstallerType;
  requestedVersion?: string;
  packages?: Record<string, string>;
  resolvedCommand: string[];
  packageDir?: string;
  binDir?: string;
  installedAt: string;
}

export interface ResolvedServerConfig {
  server: ServerDefinition;
  rootDir: string;
  rootMarker?: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  settings: JsonObject;
  initializationOptions: JsonObject;
  install?: InstalledServerMetadata;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const StringRecordSchema = Type.Record(Type.String(), Type.String());
const JsonObjectSchema = Type.Record(Type.String(), Type.Any());
const StringArraySchema = Type.Array(Type.String());

export const InstalledServerMetadataSchema = Type.Object({
  installer: Type.String(),
  requestedVersion: Type.Optional(Type.String()),
  packages: Type.Optional(StringRecordSchema),
  resolvedCommand: StringArraySchema,
  packageDir: Type.Optional(Type.String()),
  binDir: Type.Optional(Type.String()),
  installedAt: Type.String(),
});

export const InstallSpecSchema = Type.Union([
  Type.Object({
    type: Type.Literal("npm"),
    packages: StringRecordSchema,
    bin: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("go"),
    module: Type.String(),
    version: Type.Optional(Type.String()),
    bin: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("github"),
    repo: Type.String(),
    version: Type.Optional(Type.String()),
    asset: Type.Optional(Type.String()),
    downloadUrl: Type.Optional(Type.String()),
    bin: Type.String(),
    stripComponents: Type.Optional(Type.Number()),
  }),
  Type.Object({
    type: Type.Literal("system"),
    bin: Type.Optional(Type.String()),
    command: Type.Optional(StringArraySchema),
  }),
]);

export const ServerDefinitionSchema = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  filetypes: StringArraySchema,
  rootMarkers: StringArraySchema,
  install: InstallSpecSchema,
  command: StringArraySchema,
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(StringRecordSchema),
  settings: JsonObjectSchema,
  initializationOptions: JsonObjectSchema,
  lazy: Type.Boolean(),
});

export function parseServerDefinition(value: unknown): ParseResult<ServerDefinition> {
  if (Value.Check(ServerDefinitionSchema, value)) {
    return { ok: true, value: value as ServerDefinition };
  }

  return { ok: false, errors: formatSchemaErrors(ServerDefinitionSchema, value) };
}

function formatSchemaErrors(schema: unknown, value: unknown): string[] {
  return [...Value.Errors(schema as never, value)].map((error) => {
    const path = error.instancePath === "" ? "server" : `server${error.instancePath}`;
    return `${path} ${error.message}`;
  });
}
