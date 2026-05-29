import type {
  Definition,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { LspDiagnosticsResult } from "../lsp/client.js";
import type { LspRuntimeFileResult, LspWorkspaceSymbolsResult } from "../lsp/runtimeManager.js";
import type { LspResultCache } from "./resultCache.js";

export interface LspToolResult<TDetails> {
  content: [{ type: "text"; text: string }];
  details: TDetails;
}

export interface FormatOptions {
  pageSize?: number;
}

export interface PageMetadata<TItem> {
  ok: true;
  kind: string;
  total: number;
  shown: number;
  page: { start: number; end: number };
  hasMore: boolean;
  omitted: number;
  items: TItem[];
  serverId?: string;
  rootDir?: string;
  filePath?: string;
  resultId?: string;
}

export interface PositionInput {
  line: number;
  column: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface DisplayPosition {
  line: number;
  column: number;
}

export interface DisplayRange {
  start: DisplayPosition;
  end: DisplayPosition;
}

export interface DisplayLocation {
  uri: string;
  filePath?: string;
  range?: DisplayRange;
}

export interface NormalizedDiagnostic {
  severity: string;
  message: string;
  range: DisplayRange;
  source?: string;
  code?: string | number;
}

export interface NormalizedSymbol {
  name: string;
  kind: string;
  range?: DisplayRange;
  selectionRange?: DisplayRange;
  location?: DisplayLocation;
  containerName?: string;
  depth?: number;
}

export function toLspPosition(input: PositionInput): LspPosition {
  return {
    line: Math.max(0, Math.trunc(input.line) - 1),
    character: Math.max(0, Math.trunc(input.column) - 1),
  };
}

export function success<TDetails>(text: string, details: TDetails): LspToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

export function failure(tool: string, error: unknown): LspToolResult<{ ok: false; tool: string; error: string }> {
  return success(`${tool} failed: ${messageFromError(error)}`, { ok: false, tool, error: messageFromError(error) });
}

export function formatDiagnostics(
  result: LspDiagnosticsResult,
  cache?: LspResultCache,
  options: FormatOptions = {},
): LspToolResult<PageMetadata<NormalizedDiagnostic>> {
  const diagnostics = result.diagnostics.map(normalizeDiagnostic).sort(compareDiagnostics);
  return paginateItems({
    kind: "diagnostics",
    title: `LSP diagnostics for ${result.filePath} (${result.serverId}):`,
    emptyText: `No LSP diagnostics for ${result.filePath}.`,
    items: diagnostics,
    pageSize: options.pageSize ?? 50,
    cache,
    baseDetails: {
      serverId: result.serverId,
      rootDir: result.rootDir,
      filePath: result.filePath,
    },
    formatItem: (diagnostic) =>
      `- ${diagnostic.severity} ${formatRangeStart(diagnostic.range)} ${diagnostic.message}${formatSource(diagnostic)}`,
  });
}

export function formatHover(result: LspRuntimeFileResult<Hover | null>): LspToolResult<{
  ok: true;
  serverId: string;
  rootDir: string;
  filePath: string;
  hover: string | null;
  range?: DisplayRange;
}> {
  const hoverText = result.result ? hoverToText(result.result) : "";
  const range = result.result?.range ? displayRange(result.result.range) : undefined;
  return success(
    hoverText ? `LSP hover for ${result.filePath}:\n${hoverText}` : `No LSP hover result for ${result.filePath}.`,
    {
      ok: true,
      serverId: result.serverId,
      rootDir: result.rootDir,
      filePath: result.filePath,
      hover: hoverText || null,
      ...(range ? { range } : {}),
    },
  );
}

export function formatDefinition(
  result: LspRuntimeFileResult<Definition | LocationLink[] | null>,
  cache?: LspResultCache,
  options: FormatOptions = {},
): LspToolResult<PageMetadata<DisplayLocation>> {
  const locations = normalizeDefinition(result.result).sort(compareLocations(result.filePath));
  return formatPaginatedLocations("definition", result, locations, cache, options.pageSize ?? 25);
}

export function formatReferences(
  result: LspRuntimeFileResult<Location[] | null>,
  cache?: LspResultCache,
  options: FormatOptions = {},
): LspToolResult<PageMetadata<DisplayLocation>> {
  const locations = (result.result ?? []).map(normalizeLocation).sort(compareLocations(result.filePath));
  return formatPaginatedLocations("reference", result, locations, cache, options.pageSize ?? 25);
}

export function formatDocumentSymbols(
  result: LspRuntimeFileResult<DocumentSymbol[] | SymbolInformation[] | null>,
  cache?: LspResultCache,
  options: FormatOptions = {},
): LspToolResult<PageMetadata<NormalizedSymbol>> {
  const symbols = normalizeDocumentSymbols(result.result ?? []);
  return paginateItems({
    kind: "document_symbols",
    title: `LSP document symbols for ${result.filePath} (${result.serverId}):`,
    emptyText: `No LSP document symbols for ${result.filePath}.`,
    items: symbols,
    pageSize: options.pageSize ?? 80,
    cache,
    baseDetails: {
      serverId: result.serverId,
      rootDir: result.rootDir,
      filePath: result.filePath,
    },
    formatItem: (symbol) => {
      const indent = "  ".repeat(symbol.depth ?? 0);
      const location = symbol.selectionRange ?? symbol.range;
      return `${indent}- ${symbol.name} (${symbol.kind})${location ? ` ${formatRangeStart(location)}` : ""}`;
    },
  });
}

export function formatWorkspaceSymbols(
  results: LspWorkspaceSymbolsResult[],
  cache?: LspResultCache,
  options: FormatOptions & { query?: string } = {},
): LspToolResult<PageMetadata<NormalizedSymbol & { serverId: string; rootDir: string }>> {
  const symbols = results.flatMap((entry) =>
    normalizeWorkspaceSymbols(entry.result ?? []).map((symbol) => ({
      ...symbol,
      serverId: entry.serverId,
      rootDir: entry.rootDir,
    })),
  );
  const ranked = symbols.sort(compareWorkspaceSymbols(options.query ?? ""));

  return paginateItems({
    kind: "workspace_symbols",
    title: `LSP workspace symbols (${ranked.length}):`,
    emptyText: "No LSP workspace symbols found.",
    items: ranked,
    pageSize: options.pageSize ?? 50,
    cache,
    baseDetails: {},
    formatItem: (symbol) => {
      const where = symbol.location?.range ? ` ${formatRangeStart(symbol.location.range)}` : "";
      const path = symbol.location?.filePath ?? symbol.location?.uri;
      return `- ${symbol.name} (${symbol.kind}) ${symbol.serverId}${path ? ` ${path}` : ""}${where}`;
    },
  });
}

function paginateItems<TItem>(input: {
  kind: string;
  title: string;
  emptyText: string;
  items: TItem[];
  pageSize: number;
  cache?: LspResultCache;
  baseDetails: Pick<PageMetadata<TItem>, "serverId" | "rootDir" | "filePath">;
  formatItem: (item: TItem) => string;
}): LspToolResult<PageMetadata<TItem>> {
  if (input.items.length === 0) {
    return success(input.emptyText, {
      ...input.baseDetails,
      ok: true,
      kind: input.kind,
      total: 0,
      shown: 0,
      page: { start: 0, end: 0 },
      hasMore: false,
      omitted: 0,
      items: [],
    });
  }

  const pageSize = Math.max(1, Math.trunc(input.pageSize));
  const pages = chunk(input.items, pageSize).map((items, index) => {
    const start = index * pageSize + 1;
    const end = start + items.length - 1;
    const omitted = input.items.length - end;
    const details: PageMetadata<TItem> = {
      ...input.baseDetails,
      ok: true,
      kind: input.kind,
      total: input.items.length,
      shown: items.length,
      page: { start, end },
      hasMore: false,
      omitted,
      items,
    };
    const lines = [input.title, `Showing ${start}-${end} of ${input.items.length}.`];
    for (const item of items) lines.push(input.formatItem(item));
    return { text: lines.join("\n"), details };
  });

  const resultId = input.cache?.store({ label: input.kind, pages });
  if (resultId) {
    for (const page of pages) {
      if (page.details.omitted <= 0) continue;
      page.details.resultId = resultId;
      page.details.hasMore = true;
      page.text = `${page.text}\nMore available: call lsp_more with resultId: ${resultId}`;
    }
  } else if (pages.length > 1) {
    const first = pages[0]!;
    first.text = `${first.text}\nAdditional results omitted because the LSP pagination cache could not store this result set.`;
  }

  const first = pages[0]!;
  return success(first.text, first.details);
}

function formatPaginatedLocations(
  label: "definition" | "reference",
  result: LspRuntimeFileResult<unknown>,
  locations: DisplayLocation[],
  cache: LspResultCache | undefined,
  pageSize: number,
): LspToolResult<PageMetadata<DisplayLocation>> {
  const plural = locations.length === 1 ? label : `${label}s`;
  return paginateItems({
    kind: plural,
    title: `LSP ${plural} for ${result.filePath} (${result.serverId}):`,
    emptyText: `No LSP ${label} locations for ${result.filePath}.`,
    items: locations,
    pageSize,
    cache,
    baseDetails: {
      serverId: result.serverId,
      rootDir: result.rootDir,
      filePath: result.filePath,
    },
    formatItem: (location) => {
      const where = location.range ? ` ${formatRangeStart(location.range)}` : "";
      return `- ${location.filePath ?? location.uri}${where}`;
    },
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

function normalizeDiagnostic(diagnostic: Diagnostic): NormalizedDiagnostic {
  return {
    severity: diagnosticSeverityName(diagnostic.severity),
    message: diagnostic.message,
    range: displayRange(diagnostic.range),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
  };
}

function normalizeDefinition(value: Definition | LocationLink[] | null): DisplayLocation[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => (isLocationLink(entry) ? normalizeLocationLink(entry) : normalizeLocation(entry)));
}

function normalizeDocumentSymbols(values: DocumentSymbol[] | SymbolInformation[]): NormalizedSymbol[] {
  const symbols: NormalizedSymbol[] = [];
  for (const value of values) {
    if (isDocumentSymbol(value)) appendDocumentSymbol(symbols, value, 0);
    else symbols.push(normalizeSymbolInformation(value));
  }
  return symbols;
}

function normalizeWorkspaceSymbols(values: Array<SymbolInformation | WorkspaceSymbol>): NormalizedSymbol[] {
  return values.map((symbol) => ({
    name: symbol.name,
    kind: symbolKindName(symbol.kind),
    location: normalizeWorkspaceSymbolLocation(symbol.location),
    ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
  }));
}

function appendDocumentSymbol(output: NormalizedSymbol[], symbol: DocumentSymbol, depth: number): void {
  output.push({
    name: symbol.name,
    kind: symbolKindName(symbol.kind),
    range: displayRange(symbol.range),
    selectionRange: displayRange(symbol.selectionRange),
    depth,
  });
  for (const child of symbol.children ?? []) appendDocumentSymbol(output, child, depth + 1);
}

function normalizeSymbolInformation(symbol: SymbolInformation): NormalizedSymbol {
  return {
    name: symbol.name,
    kind: symbolKindName(symbol.kind),
    location: normalizeLocation(symbol.location),
    ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
  };
}

function normalizeLocation(location: Location): DisplayLocation {
  return { uri: location.uri, filePath: uriToFilePath(location.uri), range: displayRange(location.range) };
}

function normalizeLocationLink(link: LocationLink): DisplayLocation {
  return { uri: link.targetUri, filePath: uriToFilePath(link.targetUri), range: displayRange(link.targetRange) };
}

function normalizeWorkspaceSymbolLocation(location: WorkspaceSymbol["location"]): DisplayLocation {
  if ("range" in location) return normalizeLocation(location);
  return { uri: location.uri, filePath: uriToFilePath(location.uri) };
}

function hoverToText(hover: Hover): string {
  return markedContentToText(hover.contents).trim();
}

function markedContentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markedContentToText).filter(Boolean).join("\n\n");

  const objectValue = value as MarkupContent | { language?: unknown; value?: unknown };
  if ("kind" in objectValue && typeof objectValue.value === "string") return objectValue.value;
  const language = "language" in objectValue ? objectValue.language : undefined;
  if (typeof language === "string" && typeof objectValue.value === "string") {
    return `\`\`\`${language}\n${objectValue.value}\n\`\`\``;
  }
  return "";
}

function displayRange(range: Range): DisplayRange {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
  };
}

function formatRangeStart(range: DisplayRange): string {
  return `${range.start.line}:${range.start.column}`;
}

function formatSource(diagnostic: NormalizedDiagnostic): string {
  const parts = [diagnostic.source, diagnostic.code === undefined ? undefined : String(diagnostic.code)].filter(
    Boolean,
  );
  return parts.length === 0 ? "" : ` [${parts.join("/")}]`;
}

function compareDiagnostics(a: NormalizedDiagnostic, b: NormalizedDiagnostic): number {
  const severity = diagnosticSeverityRank(a.severity) - diagnosticSeverityRank(b.severity);
  if (severity !== 0) return severity;
  return a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column;
}

function diagnosticSeverityName(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "diagnostic";
  }
}

function diagnosticSeverityRank(severity: string): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "information":
      return 2;
    case "hint":
      return 3;
    default:
      return 4;
  }
}

function compareLocations(anchorFilePath: string): (a: DisplayLocation, b: DisplayLocation) => number {
  return (a, b) =>
    locationScore(anchorFilePath, a) - locationScore(anchorFilePath, b) ||
    (a.filePath ?? a.uri).localeCompare(b.filePath ?? b.uri) ||
    (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
    (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0);
}

function locationScore(anchorFilePath: string, location: DisplayLocation): number {
  const path = location.filePath ?? location.uri;
  let score = 0;
  if (path !== anchorFilePath) score += 10;
  if (isLowSignalPath(path)) score += 25;
  return score;
}

function compareWorkspaceSymbols(query: string): (a: NormalizedSymbol, b: NormalizedSymbol) => number {
  return (a, b) =>
    workspaceSymbolScore(query, a) - workspaceSymbolScore(query, b) ||
    a.name.localeCompare(b.name) ||
    (a.location?.filePath ?? a.location?.uri ?? "").localeCompare(b.location?.filePath ?? b.location?.uri ?? "");
}

function workspaceSymbolScore(query: string, symbol: NormalizedSymbol): number {
  const normalizedQuery = query.toLowerCase();
  const normalizedName = symbol.name.toLowerCase();
  let score = 0;
  if (normalizedQuery) {
    if (normalizedName === normalizedQuery) score -= 100;
    else if (normalizedName.startsWith(normalizedQuery)) score -= 60;
    else if (normalizedName.includes(normalizedQuery)) score -= 20;
  }

  const path = symbol.location?.filePath ?? symbol.location?.uri ?? "";
  if (isLowSignalPath(path)) score += 25;
  return score;
}

function isLowSignalPath(path: string): boolean {
  return /(?:^|\/)(node_modules|dist|build|coverage|fixtures|\.next|generated)(?:\/|$)/u.test(path);
}

function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `kind-${kind}`;
}

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

function isDocumentSymbol(value: DocumentSymbol | SymbolInformation): value is DocumentSymbol {
  return "selectionRange" in value;
}

function uriToFilePath(uri: string): string | undefined {
  try {
    const parsed = URI.parse(uri);
    return parsed.scheme === "file" ? parsed.fsPath : undefined;
  } catch {
    return undefined;
  }
}

function messageFromError(error: unknown): string {
  return conciseExpectedError(error instanceof Error ? error.message : String(error));
}

function conciseExpectedError(message: string): string {
  const trimmed = message.trim();
  const firstLine = firstMeaningfulLine(trimmed);

  const missingFile = /ENOENT: no such file or directory, open '([^']+)'/u.exec(trimmed);
  if (missingFile) {
    return `File not found: ${missingFile[1]}. Check filePath and try again.`;
  }

  if (/Bad line number|lineStarts\.length/iu.test(trimmed)) {
    return "Position is outside the file. Use a valid 1-based line/column from the file and place the column on an identifier token.";
  }

  if (/outside .*: (line|column)|Invalid LSP position/iu.test(trimmed)) {
    return firstLine;
  }

  if (/No LSP filetype detected/iu.test(trimmed)) {
    return `${firstLine} Use a supported source file path.`;
  }

  if (/outside workspace/iu.test(trimmed)) {
    return `${firstLine} Use a file under the current workspace.`;
  }

  if (/timed out after \d+ms/iu.test(trimmed)) {
    return `${firstLine} Retry the request, or run /lsp restart if the language server stays stuck.`;
  }

  if (/does not support LSP/iu.test(trimmed)) {
    return `${firstLine} Try a different LSP tool or server for this file.`;
  }

  if (/Request .* failed with message:/u.test(trimmed) && trimmed.includes("\n")) {
    return firstLine;
  }

  return firstLine;
}

function firstMeaningfulLine(message: string): string {
  const [firstLine = message] = message.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return firstLine.trim().replace(/\.$/u, "");
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enumMember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeParameter",
};
