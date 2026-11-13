# Cletus

A pi-inspired terminal coding agent.

## Install

```bash
npm i -g cletus
# or run without installing
npx cletus
```

Requires Node >= 26.4 on macOS or Linux. The TUI uses OpenTUI, which needs the FFI flag; the installed `cletus` shebang adds it automatically. When running the build directly, use `node --experimental-ffi packages/coding-agent/dist/cli.js`.

## First run

If you already use [pi](https://pi.dev), import its model configuration:

```bash
cletus import-pi
```

This reads `~/.pi/agent/models.json` and `settings.json`, writes `~/.cletus/config.json`, and stores literal provider keys in `~/.cletus/auth.json` (mode `0600`). Old pi sessions are not imported.

Start the TUI:

```bash
cletus
# direct build:
node --experimental-ffi packages/coding-agent/dist/cli.js
```

Or run once:

```bash
cletus -p "Summarize this repository"
cletus --json -p "List the TODOs" | jq .
```

## Permissions

Read tools are confined to the working directory plus configured skill/prompt roots. Writes and command execution require confirmation. `--yolo` disables confirmations; use it only in trusted workspaces. Non-interactive `-p`/`--json` runs deny writes and commands unless `--yolo` is passed.

Persistent write allowlist (glob patterns relative to the current cwd):

```bash
cletus permissions list
cletus permissions add 'src/**'
cletus permissions remove 'src/**'
cletus permissions reset
```

In the TUI use `/permissions list`, `/permissions add src/**`, `/permissions remove src/**`, `/permissions reset`. Matching writes skip confirmation, but still stay inside the cwd and can never modify `.git`.

`/yolo` toggles YOLO mode for the current session; `/yolo on` and `/yolo off` set it explicitly. The status bar shows `YOLO` while it is active. `/new` and `/resume` restore the startup mode (`--yolo` or off).

## Keys

| Key | Action |
|---|---|
| Enter | send |
| Ctrl+J | newline |
| Ctrl+C | abort / clear input / exit |
| Ctrl+D | exit when input is empty |
| Ctrl+O | toggle tool output |
| PgUp/PgDown | scroll transcript |
| Tab | complete slash command |
| Up/Down | history (empty input) |

Override bindings in `~/.cletus/config.json` under `tui.keybindings`, for example:

```json
{ "tui": { "theme": "tokyo-night", "keybindings": { "abort": "ctrl+x" } } }
```

Keybinding changes apply on the next launch. `/theme` switches and persists immediately.

## Slash commands

Type `/` to open the command palette; use Up/Down, then Enter or Tab to insert a command. `Enter` on a complete command such as `/quit` runs it immediately.

`/help`, `/quit`, `/new`, `/resume`, `/compact`, `/model`, `/theme`, `/keys`, `/skills`, `/permissions`, `/yolo`, `/mcp`, `/reload`, `/skill:<name>`, plus prompt templates from `~/.cletus/prompts` and `.cletus/prompts`.

## Skills

`/skills` opens an interactive manager: select a skill, then enable/disable model invocation, show its path, or reload. The toggle edits `disable-model-invocation` in the skill's frontmatter. `/skill:<name>` always works even when model invocation is disabled.

CLI equivalents:

```bash
cletus skills list
cletus skills enable demo
cletus skills disable demo
```

## Web search

`web_search` is a built-in client tool backed by a sequential provider chain:

```text
brave → tavily → searxng → duckduckgo
```

- `BRAVE_API_KEY` enables Brave
- `TAVILY_API_KEY` enables Tavily
- `SEARXNG_ENDPOINT` enables a self-hosted SearXNG
- DuckDuckGo HTML is keyless and is the final fallback

Configure in `~/.cletus/config.json`:

```json
{
  "webSearch": {
    "enabled": true,
    "order": ["brave", "tavily", "searxng", "duckduckgo"],
    "timeoutSeconds": 30
  }
}
```

The tool supports `site:`, `-site:`, `filetype:` constraints and `recency` filters, returns titles/URLs/snippets, and requires confirmation unless `--yolo` is active.

## Project resources

- `AGENTS.md` / `CLAUDE.md` (global and project) are injected into the system prompt.
- Skills: `~/.cletus/skills/**/SKILL.md`, `.cletus/skills`, `.agents/skills`.
- Prompt templates: `~/.cletus/prompts/*.md`, `.cletus/prompts/*.md`.
- Extensions: `~/.cletus/extensions/*.ts`, `.cletus/extensions/*.ts` (requires project trust).
- MCP: `~/.cletus/mcp.json`, `.cletus/mcp.json`. Servers connect in the background, so the TUI opens immediately; `MCP ready` appears when tools are registered.

## License

MIT