import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";
import {
  failure,
  formatDefinition,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatReferences,
  formatWorkspaceSymbols,
  toLspPosition,
} from "./lspFormat.js";
import { LSP_RESULT_ID_LENGTH, LSP_RESULT_ID_PATTERN } from "./resultCache.js";

export type GetLspToolState = () => LspExtensionState | null;

const FilePathParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
});

const FilePositionParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
});

const ReferencesParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  column: Type.Integer({
    minimum: 1,
    description: "1-based column/character number. For symbol queries, place it on the identifier token.",
  }),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "Whether to include the symbol declaration in the result." }),
  ),
});

const WorkspaceSymbolsParams = Type.Object({
  query: Type.String({ description: "Workspace symbol query string." }),
  serverId: Type.Optional(Type.String({ description: "Optional LSP server id to query, e.g. pyright or vtsls." })),
});

const MoreParams = Type.Object({
  resultId: Type.String({
    description: "Exact cached LSP resultId returned by a previous paginated LSP tool result.",
    pattern: LSP_RESULT_ID_PATTERN,
    minLength: LSP_RESULT_ID_LENGTH,
    maxLength: LSP_RESULT_ID_LENGTH,
  }),
});

export function registerLspTools(pi: ExtensionAPI, getState: GetLspToolState): void {
  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Read diagnostics for a file using its configured language server.",
    promptSnippet: "Inspect compiler/type/lint diagnostics from configured language servers for a file.",
    promptGuidelines: [
      "Use lsp_diagnostics after reading or editing code when semantic errors, type errors, or language-server diagnostics would help.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_diagnostics", "LSP extension is not initialized.");
      try {
        const result = formatDiagnostics(await state.runtimeManager.diagnostics(params.filePath), state.resultCache);
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_diagnostics", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get hover/type information at a source position. line and column are 1-based.",
    promptSnippet: "Fetch hover/type information for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_hover when symbol type, signature, documentation, or inferred information would reduce guesswork. Put line/column on the identifier token itself, not whitespace or surrounding syntax.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_hover", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatHover(
          await state.runtimeManager.hover(params.filePath, position.line, position.character),
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_hover", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Find definition locations for the symbol at a source position. line and column are 1-based.",
    promptSnippet: "Jump to definitions for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_definition before changing unfamiliar call sites, types, or imported symbols. Put line/column on the identifier token itself, not an import path string or surrounding syntax.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_definition", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatDefinition(
          await state.runtimeManager.definition(params.filePath, position.line, position.character),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_definition", error);
      }
    },
  });

  pi.registerTool<typeof ReferencesParams, unknown>({
    name: "lsp_references",
    label: "LSP References",
    description: "Find references for the symbol at a source position. line and column are 1-based.",
    promptSnippet: "Find references for a symbol at a 1-based line and column.",
    promptGuidelines: [
      "Use lsp_references to assess impact before renames, API changes, or behavior changes. Put line/column on the identifier token itself; set includeDeclaration when you need the declaration included in the results.",
    ],
    parameters: ReferencesParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_references", "LSP extension is not initialized.");
      try {
        const position = toLspPosition(params);
        const result = formatReferences(
          await state.runtimeManager.references(
            params.filePath,
            position.line,
            position.character,
            params.includeDeclaration ?? false,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_references", error);
      }
    },
  });

  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_document_symbols",
    label: "LSP Document Symbols",
    description: "List symbols in a source file using its configured language server.",
    promptSnippet: "List functions, classes, variables, and other symbols in a source file.",
    promptGuidelines: [
      "Use lsp_document_symbols to understand a file's semantic structure before broad edits or before reading a large unfamiliar file end-to-end.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_document_symbols", "LSP extension is not initialized.");
      try {
        const result = formatDocumentSymbols(
          await state.runtimeManager.documentSymbols(params.filePath),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_document_symbols", error);
      }
    },
  });

  pi.registerTool<typeof WorkspaceSymbolsParams, unknown>({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description:
      "Search symbols across active LSP workspaces. Optionally provide a server id to start/query that server for the current cwd.",
    promptSnippet: "Search workspace symbols by name across active language-server sessions.",
    promptGuidelines: [
      "Use lsp_workspace_symbols to locate definitions or related symbols by name when file paths are unknown. Omit serverId to query active servers only; provide a configured serverId, such as vtsls or pyright, when you want to start/query a specific server for the current cwd.",
    ],
    parameters: WorkspaceSymbolsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_workspace_symbols", "LSP extension is not initialized.");
      try {
        const result = formatWorkspaceSymbols(
          await state.runtimeManager.workspaceSymbols(params.query, params.serverId),
          state.resultCache,
          { query: params.query },
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_workspace_symbols", error);
      }
    },
  });

  pi.registerTool<typeof MoreParams, unknown>({
    name: "lsp_more",
    label: "LSP More Results",
    description: "Return the next cached page from a previous paginated LSP result.",
    promptSnippet:
      "Fetch the next sequential page for a previous LSP resultId without re-querying the language server.",
    promptGuidelines: [
      "Use lsp_more only when the previous LSP result explicitly says 'More available' and provides a resultId. Cached pages are sequential and may expire after cache eviction or session restart; if a resultId is missing or expired, re-run the original LSP query.",
    ],
    parameters: MoreParams,
    async execute(_toolCallId, params) {
      const state = getState();
      if (!state) return failure("lsp_more", "LSP extension is not initialized.");
      return state.resultCache.next(params.resultId);
    },
  });
}

function refreshStatus(ctx: ExtensionContext | undefined, state: LspExtensionState): void {
  if (ctx) setLspStatusLine(ctx, state);
}
