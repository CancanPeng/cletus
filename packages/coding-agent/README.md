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

`/help`, `/quit`, `/new`, `/resume`, `/compact`, `/model`, `/theme`, `/keys`, `/skills`, `/mcp`, `/reload`, `/skill:<name>`, plus prompt templates from `~/.cletus/prompts` and `.cletus/prompts`.

## Skills

`/skills` opens an interactive manager: select a skill, then enable/disable model invocation, show its path, or reload. The toggle edits `disable-model-invocation` in the skill's frontmatter. `/skill:<name>` always works even when model invocation is disabled.

CLI equivalents:

```bash
cletus skills list
cletus skills enable demo
cletus skills disable demo
```

## Project resources

- `AGENTS.md` / `CLAUDE.md` (global and project) are injected into the system prompt.
- Skills: `~/.cletus/skills/**/SKILL.md`, `.cletus/skills`, `.agents/skills`.
- Prompt templates: `~/.cletus/prompts/*.md`, `.cletus/prompts/*.md`.
- Extensions: `~/.cletus/extensions/*.ts`, `.cletus/extensions/*.ts` (requires project trust).
- MCP: `~/.cletus/mcp.json`, `.cletus/mcp.json`.

## License

MIT