# pi-lsp-extension

Language-server intelligence for [Pi](https://github.com/earendil-works/pi) agents: diagnostics, hover/type info, definitions, references, and symbol search on demand.

`pi-lsp-extension` gives Pi a small set of read-only LSP tools without turning startup into an IDE boot. Language servers are lazy at session startup, installed servers can be warmed in the background when Pi reads source files, managed installs are isolated under Pi's runtime directory, and large LSP responses are paginated through a short-lived cache so they do not flood the context window.

## Why this exists

Agents make better edits when they can ask semantic questions instead of guessing from text search alone:

- _What type is this symbol?_
- _Where is this function defined?_
- _What references will this change affect?_
- _Did the language server report a type or lint error?_

LSP already answers those questions. This extension makes those answers available to Pi as compact, read-only tools. It starts servers only when needed, keeps missing-server installs explicit by default, and returns the first useful page instead of dumping thousands of references into the model.

## Install

Install from git:

```bash
pi install git:github.com/nikmmd/pi-lsp-extension
```

Restart Pi after installation, then check the extension:

```text
/lsp status
```

For local development from a checkout:

```bash
git clone https://github.com/nikmmd/pi-lsp-extension.git
cd pi-lsp-extension
npm install
pi -e "$PWD"
```

The default install mode is `prompt`: agent tool calls will not silently install missing language servers. Install servers explicitly with `/lsp install <serverId>`, or set `installMode` to `auto` if you want first-use installation.

## What happens on first use

| You do this                                            | What happens                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Run `/lsp` in an interactive Pi session                | Pi opens a compact LSP panel showing configured servers, install state, tracked processes, and config warnings.                                 |
| Run `/lsp status`                                      | Pi prints the same status as text.                                                                                                              |
| Run `/lsp install pyright`                             | The server is installed under `~/.pi/agent/lsp/`, and the resolved command is recorded in Pi's LSP lockfile.                                    |
| Read a supported source file with Pi's `read` tool     | If `warmup` is enabled, the matching installed server is started in the background. Missing servers are ignored.                                |
| Ask for diagnostics/hover/definitions on a source file | The extension detects the filetype and project root, reuses a warmed server or starts the matching server if needed, then runs the LSP request. |
| Query many references or symbols                       | The first ranked page is returned immediately. If more pages exist, the result includes a `resultId` for `lsp_more`.                            |
| Configure a Mason/Nix/system binary                    | Pi uses that command but does not own, update, or uninstall it. Use global config for executable overrides.                                     |

## Quick start

```text
/lsp status
/lsp install vtsls
```

Then ask Pi something that benefits from semantic context:

```text
Check diagnostics for src/index.ts, then use hover on the exported function before editing it.
```

Useful first commands:

```text
/lsp doctor vtsls
/lsp install pyright
/lsp start
```

## Tools

The extension registers these read-only tools:

| Tool                    | Use it for                                            | Required input                                         |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `lsp_diagnostics`       | Compiler/type/lint diagnostics for one file           | `filePath`                                             |
| `lsp_hover`             | Type, signature, and documentation at a position      | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_definition`        | Definition locations for a symbol                     | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_references`        | Reference locations for a symbol                      | `filePath`, 1-based `line`, 1-based `column`           |
| `lsp_document_symbols`  | Classes, functions, variables, and other file symbols | `filePath`                                             |
| `lsp_workspace_symbols` | Symbol search across active or selected workspaces    | `query`; optional `serverId`                           |
| `lsp_more`              | Next page from a cached multi-page LSP result         | Exact `resultId` returned by a previous paginated call |

Examples:

```text
lsp_diagnostics({ filePath: "src/index.ts" })
```

```text
lsp_hover({ filePath: "src/index.ts", line: 42, column: 13 })
```

```text
lsp_workspace_symbols({ query: "RuntimeManager", serverId: "vtsls" })
```

Line and column inputs are 1-based. For hover, definitions, and references, put the column on the identifier token itself rather than on whitespace or an import path string.

## Supported servers

Built-in catalog entries currently include:

| Server          | Languages/filetypes              | Managed installer |
| --------------- | -------------------------------- | ----------------- |
| `vtsls`         | JavaScript, JSX, TypeScript, TSX | npm               |
| `pyright`       | Python                           | npm               |
| `gopls`         | Go                               | go                |
| `rust-analyzer` | Rust                             | GitHub release    |
| `yamlls`        | YAML                             | npm               |
| `jsonls`        | JSON, JSONC                      | npm               |
| `jdtls`         | Java                             | GitHub release    |

You can override these definitions or add new server definitions in config.

## Configuration

Most users only need one file:

```text
~/.pi/agents/lsp.json
```

If that file does not exist, the extension behaves as if this config were present:

```json
{
  "installMode": "prompt",
  "warmup": true,
  "servers": {}
}
```

`servers: {}` means "use the built-in server catalog unchanged". Add entries only when you want to override a built-in server or define a new one.

### Config files and merge order

| Priority | Path                    | Purpose                                                                                                          |
| -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1        | built-in catalog        | Default server definitions for `vtsls`, `pyright`, `gopls`, `rust-analyzer`, `yamlls`, etc.                      |
| 2        | `~/.pi/agents/lsp.json` | User-global config. Best place for executable, install, PATH, `installMode`, and `warmup`.                       |
| 3        | `.pi/lsp.json`          | Project-local config. Safe server fields are honored before trust; process-starting fields require `/lsp trust`. |

> Path gotcha: config uses `~/.pi/agents/lsp.json` (`agents` plural). Runtime state uses `~/.pi/agent/lsp/` (`agent` singular).

### Runtime paths

Do not edit these by hand unless you are debugging or cleaning up state:

| Path                            | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `~/.pi/agent/lsp/packages/`     | Pi-managed language-server installs                        |
| `~/.pi/agent/lsp/bin/`          | Pi-managed executable links                                |
| `~/.pi/agent/lsp/lsp.lock.json` | Resolved managed install metadata                          |
| `~/.pi/agent/lsp/logs/`         | Language-server logs                                       |
| `~/.pi/agent/lsp/lsp.pid.json`  | Process registry used for lifecycle cleanup                |
| `~/.pi/agent/lsp/workspaces/`   | Per-server workspaces, for example JDT LS data directories |
| `~/.pi/agent/lsp/cache/`        | Runtime caches owned by the extension                      |

Do not put extension source code under `~/.pi/agent/lsp/`; that directory is only for runtime state.

### Top-level config fields

| Field         | Default    | Behavior                                                                                       |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `installMode` | `"prompt"` | Missing servers are installed only when explicitly requested or interactively confirmed.       |
| `warmup`      | `true`     | Pi `read` calls for supported source files start matching installed servers in the background. |
| `servers`     | `{}`       | Per-server overrides merged into the built-in catalog.                                         |

`installMode` can be:

| Mode     | Behavior                                                                    |
| -------- | --------------------------------------------------------------------------- |
| `prompt` | Install only when explicitly requested or interactively confirmed.          |
| `auto`   | Install missing servers automatically when an LSP tool needs them.          |
| `off`    | Never install automatically. Use system commands or explicit installs only. |

`warmup` never prompts and never installs missing servers. It only prepares already-installed servers after Pi reads a matching source file. `lazy` still means servers do not start at session startup.

### Common config snippets

Disable read warmup:

```json
{
  "warmup": false
}
```

Auto-install missing servers on first explicit LSP tool use:

```json
{
  "installMode": "auto"
}
```

Tune Pyright analysis from project config without changing executables:

```json
{
  "servers": {
    "pyright": {
      "settings": {
        "python": {
          "analysis": {
            "diagnosticMode": "workspace"
          }
        }
      }
    }
  }
}
```

### Server override fields

A server definition can include:

| Field                   | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `displayName`           | Human-readable name shown in status output                  |
| `filetypes`             | Filetypes handled by the server                             |
| `rootMarkers`           | Files/directories used to detect the project root           |
| `install`               | Managed install spec: `npm`, `go`, `github`, or `system`    |
| `command`               | Command used to start the language server                   |
| `cwd`                   | Working directory for the server command                    |
| `env`                   | Environment overrides; supports `$env:VAR` references       |
| `settings`              | LSP settings returned through `workspace/configuration`     |
| `initializationOptions` | LSP initialization options                                  |
| `lazy`                  | Whether the server should avoid session-start eager startup |

`command` supports placeholders such as `{installBin}`, `{installDir}`, `{platform}`, and `{workspaceDir}`. Relative path-like values are resolved from the detected project root, and `~` is expanded.

Project config is intentionally conservative. In untrusted projects, executable and install overrides are ignored; put those in global config.

## Using existing LSP binaries

You do not need Pi to manage every language server. If you already have servers installed through Mason.nvim, your distro, Nix, mise/asdf, or another tool, point `pi-lsp-extension` at those binaries with global config.

Prefer global config for executable overrides:

```text
~/.pi/agents/lsp.json
```

Example: use Mason.nvim's Pyright:

```json
{
  "servers": {
    "pyright": {
      "install": {
        "type": "system",
        "command": ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"]
      },
      "command": ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"]
    }
  }
}
```

Example: use a binary already on `PATH`:

```json
{
  "servers": {
    "gopls": {
      "install": {
        "type": "system",
        "bin": "gopls"
      },
      "command": ["gopls"]
    }
  }
}
```

Why configure this explicitly instead of symlinking Mason into Pi's managed directory?

- Ownership stays clear: Mason owns Mason installs; Pi owns `~/.pi/agent/lsp/`.
- `/lsp uninstall <serverId>` will not remove external binaries.
- `/lsp doctor <serverId>` can show the configured command directly.
- Broken or stale symlinks are avoided.

## Caching and pagination

List-like LSP tools return a first page instead of dumping every result into context. When more results exist, output includes a `resultId`:

```text
Showing 1-25 of 143.
More available: call lsp_more with resultId: lspres_...
```

Fetch the next page with:

```text
lsp_more({ resultId: "lspres_..." })
```

Cache behavior:

- Only multi-page results are cached.
- Pages are returned sequentially by `lsp_more`.
- Result IDs are session-local and in memory only.
- Cache budget defaults to 64 MB and 128 entries.
- Entries expire after 15 minutes of inactivity.
- Cache is cleared on reload, shutdown, and session replacement.
- Tool result details contain only the shown page, not the full result set.

## Commands

| Command                             | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `/lsp`                              | Open the interactive LSP panel, or show status in non-UI sessions |
| `/lsp status`                       | Print status as text                                              |
| `/lsp doctor`                       | Show config warnings and server details                           |
| `/lsp doctor <serverId>`            | Show resolved details for one server                              |
| `/lsp install <serverId[@version]>` | Install a managed language server                                 |
| `/lsp update <serverId[@version]>`  | Update/reinstall one managed server                               |
| `/lsp update --all`                 | Update all configured managed servers                             |
| `/lsp uninstall <serverId>`         | Remove Pi-managed install state and stop matching processes       |
| `/lsp start [serverId]`             | Start one installed server or all installed servers               |
| `/lsp restart [serverId]`           | Restart one installed server or all installed servers             |
| `/lsp stop [serverId]`              | Stop tracked LSP processes                                        |

Interactive `/lsp` panel keys:

```text
↑↓ select • enter doctor • i install • u update • x uninstall • s stop • r refresh • esc close
```

## How it works

- The extension adds read-only LSP tools and prompt guidance to Pi.
- File requests are resolved by filetype and nearest project root marker.
- Server definitions come from the built-in catalog plus global/project config.
- Missing-server behavior follows `installMode`; read warmup never installs missing servers.
- Servers start lazily over stdio and are tracked in a process registry.
- When `warmup` is enabled, source-file reads can prepare installed servers in the background before an LSP tool call.
- LSP responses are normalized into compact text plus structured details.
- Diagnostics, locations, and symbols are sorted/paged before reaching the model.
- Extra pages are stored in the in-memory result cache and fetched with `lsp_more`.
- The Pi status line shows active LSP servers, total configured servers, and warning count.

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

For local development with Pi:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfnT "$PWD" ~/.pi/agent/extensions/pi-lsp-extension
pi
```

Run `/reload` in Pi after editing the extension.

## Troubleshooting

### `server is not installed`

Install it explicitly:

```text
/lsp install <serverId>
```

Or set global config to auto-install:

```json
{
  "installMode": "auto"
}
```

### Check the resolved command

```text
/lsp doctor <serverId>
```

This is the quickest way to see the final command, root markers, install state, and config warnings for one server.

### Reuse Mason.nvim servers

Configure the server as `type: "system"` in `~/.pi/agents/lsp.json` and point `command` at the Mason binary. Pi will use it but will not manage or uninstall it.

### Start fresh for one server

```text
/lsp stop <serverId>
/lsp uninstall <serverId>
/lsp install <serverId>
```

This only removes Pi-managed install state. It does not remove external system/Mason binaries configured with `type: "system"`.

## Limitations

- Tools are read-only. Rename, code action, and formatting support are intentionally not exposed yet.
- A language server must support the requested LSP capability for the matching tool to return data.
- First explicit LSP use can still be slower while a server starts, initializes, or installs, especially when warmup is disabled or the server was not installed when the file was read.
- `lsp_workspace_symbols` searches active clients by default; pass `serverId` to start/query a specific configured server.
- Pagination result IDs are not persistent and can expire. Re-run the original LSP query if `lsp_more` says the cached result is gone.
