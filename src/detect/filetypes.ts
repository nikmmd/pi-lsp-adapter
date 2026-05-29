import { BUILTIN_FILETYPE_RULES } from "../registry/builtin.js";
import type { FiletypeRules } from "../registry/schema.js";

export interface FiletypeOverrides extends FiletypeRules {
  filenames?: Record<string, string>;
}

export interface DetectFiletypeInput {
  path: string;
  content?: string;
  overrides?: FiletypeOverrides;
}

export function detectFiletype(input: DetectFiletypeInput): string | undefined {
  const basenameKey = getBasename(normalizePath(input.path)).toLowerCase();
  const extension = getExtension(basenameKey);

  return (
    detectFromOverrides(input.overrides, basenameKey, extension) ??
    lookupCaseInsensitive(BUILTIN_FILETYPE_RULES.exactFilenames, basenameKey) ??
    lookupCaseInsensitive(BUILTIN_FILETYPE_RULES.extensions, extension) ??
    detectFromContent(input.content)
  );
}

function detectFromOverrides(
  overrides: FiletypeOverrides | undefined,
  basenameKey: string,
  extension: string,
): string | undefined {
  if (!overrides) return undefined;

  const exactFilenames = { ...overrides.filenames, ...overrides.exactFilenames };
  return lookupCaseInsensitive(exactFilenames, basenameKey) ?? lookupCaseInsensitive(overrides.extensions, extension);
}

function detectFromContent(content: string | undefined): string | undefined {
  if (!content) return undefined;

  const sample = content.trimStart();
  if (!sample) return undefined;

  if (sample.startsWith("{") || sample.startsWith("[")) {
    return "json";
  }

  if (sample.startsWith("---\n") || sample.startsWith("---\r\n")) {
    return "yaml";
  }

  if (sample.startsWith("#!/")) {
    const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
    if (/\bpython(?:\d+(?:\.\d+)*)?\b/.test(firstLine)) return "python";
    if (/\bnode\b/.test(firstLine)) return "javascript";
  }

  return undefined;
}

function normalizePath(path: string): string {
  const withoutAt = path.startsWith("@") ? path.slice(1) : path;
  return withoutAt.replace(/\\/g, "/");
}

function getBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function getExtension(basename: string): string {
  const index = basename.lastIndexOf(".");
  if (index <= 0) return "";
  return basename.slice(index);
}

function lookupCaseInsensitive(values: Record<string, string> | undefined, key: string): string | undefined {
  if (!values) return undefined;

  for (const [entryKey, filetype] of Object.entries(values)) {
    if (entryKey.toLowerCase() === key) {
      return filetype;
    }
  }

  return undefined;
}
