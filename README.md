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

`/help`, `/quit`, `/new`, `/resume`, `/compact`, `/model`, `/theme`, `/keys`, `/skills`, `/permissions`, `/yolo`, `/mcp`, `/reload`, plus each user-invocable skill by its own name (for example `/using-git-worktrees`) and prompt templates from `~/.cletus/prompts` and `.cletus/prompts`.

## Skills

`/skills` opens a single popup manager inspired by Claude Code. Use Up/Down to move, `Space` to cycle visibility, and `Enter` or `Esc` to close. Changes are saved immediately to `~/.cletus/config.json`.

| State | Listed to model | `/<skill-name>` |
|---|---|---|
| `on` | name + description | yes |
| `name-only` | name only | yes |
| `user-invocable-only` | hidden | yes |
| `off` | hidden | hidden |

The choice is saved to `skillOverrides` in `~/.cletus/config.json`, so shared `SKILL.md` files are never modified. Frontmatter `disable-model-invocation` and `user-invocable` are honored when no override is set. Skill names fall back to the directory name, descriptions fall back to the first non-empty body line, and `when_to_use` is appended to the model listing.

CLI equivalents:

```bash
cletus skills list
cletus skills set demo name-only
cletus skills set demo user-only
cletus skills enable demo   # alias for on
cletus skills disable demo  # alias for off
```

## Web search

`web_search` is a built-in client tool backed by a sequential provider chain:

```text
parallel → exa → firecrawl → brave → tavily → searxng → duckduckgo
```

`parallel`, `exa`, and `firecrawl` use keyless endpoints and work without API keys.

- `BRAVE_API_KEY` enables Brave
- `TAVILY_API_KEY` enables Tavily
- `SEARXNG_ENDPOINT` enables a self-hosted SearXNG
- DuckDuckGo HTML is keyless and is the final fallback

Configure in `~/.cletus/config.json`:

```json
{
  "webSearch": {
    "enabled": true,
    "order": ["parallel", "exa", "firecrawl", "brave", "tavily", "searxng", "duckduckgo"],
    "timeoutSeconds": 30
  }
}
```

The tool supports `site:`, `-site:`, `filetype:` constraints and `recency` filters, returns titles/URLs/snippets, and requires confirmation unless `--yolo` is active.

## Project resources

- `AGENTS.md` / `CLAUDE.md` (global and project) are injected into the system prompt.
- Skills: `~/.cletus/skills`, `~/.agents/skills`, `~/.claude/skills`, plus `.cletus/skills`, `.agents/skills`, and `.claude/skills` in the project and ancestors.
- Prompt templates: `~/.cletus/prompts/*.md`, `.cletus/prompts/*.md`.
- Extensions: `~/.cletus/extensions/*.ts`, `.cletus/extensions/*.ts` (requires project trust).
- MCP: `~/.cletus/mcp.json`, `.cletus/mcp.json`. Servers connect in the background, so the TUI opens immediately; `MCP ready` appears when tools are registered.

## License

MIT