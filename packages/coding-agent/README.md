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

## Turn limits

Long autonomous runs are bounded so a runaway loop cannot spend forever. The agent stops after `maxTurns` turns (default **500**) and — instead of failing — starts another batch, up to `maxAutoContinues` times (default **3**), so a single prompt can run up to 2000 turns.

Reaching the limit is not an error: nothing is written to the session transcript, the conversation stays resumable, and the last message is the real tool result. When every batch is used the run stops cleanly with a notice; send another message to keep going.

```json
{
  "maxTurns": 500,
  "maxAutoContinues": 3
}
```

Override the batch size per run with `--max-turns <n>`. Subagents get a hard 30-turn cap with no auto-continue, since they cannot ask to keep going.

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

`/thinking` toggles model reasoning output (`/thinking on` / `/thinking off`). It is persisted as `tui.showThinking`; thinking text is rendered before the final answer with the muted color.

Bash stdout/stderr streams into the tool card while the command runs (up to every 100ms). Use `Ctrl+O` or `/verbose` to keep the card expanded and watch the full stream.

`/verbose` toggles full tool output for the current session (`/verbose on` and `/verbose off` set it explicitly). The status bar shows `verbose` while active; `Ctrl+O` is the keyboard shortcut.

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
| Mouse wheel | scroll transcript; auto-follow pauses when scrolled up |
| Mouse selection | releasing the left button copies the selected text |
| Cmd+C / Ctrl+Shift+C | copy selected text, or the whole input if nothing is selected |
| Cmd+V / Ctrl+Shift+V / Ctrl+V | paste from the host clipboard |
| Tab | complete slash command |
| Up/Down | history (empty input) |

Override bindings in `~/.cletus/config.json` under `tui.keybindings`, for example:

```json
{ "tui": { "theme": "tokyo-night", "keybindings": { "abort": "ctrl+x" } } }
```

Keybinding changes apply on the next launch. `/theme` switches and persists immediately.

## Status bar

Icons: `◆` app, `◈` model, `⌂` cwd, `⎇` git branch, `▣` session, `✓` ready, `▤` context usage, `◷` last duration, `≡` queued, `▲` YOLO, `⚑` permission, `❖` skills manager.

Symbol presets:

```text
/symbols nerd      # default (Nerd Font glyphs)
/symbols unicode   # standard Unicode glyphs
/symbols ascii     # ASCII fallback
```

Configure in `~/.cletus/config.json`:

```json
{
  "tui": {
    "symbols": {
      "preset": "nerd",
      "overrides": { "ready": "OK" }
    }
  }
}
```

## Slash commands

Type `/` to open the command palette; use Up/Down, then Enter or Tab to insert a command. `Enter` on a complete command such as `/quit` runs it immediately.

`/help`, `/quit`, `/new`, `/resume`, `/compact`, `/model`, `/theme`, `/symbols`, `/keys`, `/skills`, `/permissions`, `/yolo`, `/verbose`, `/thinking`, `/mcp`, `/reload`, plus each user-invocable skill by its own name (for example `/using-git-worktrees`) and prompt templates from `~/.cletus/prompts` and `.cletus/prompts`.

## Skills

`/skills` opens a tabbed popup manager (`Skills`, `Search`, `Install`). `Tab` / `Shift+Tab` switch tabs. Changes are saved immediately to `~/.cletus/config.json`.

| Tab | Keys |
|---|---|
| `Skills` | type to filter, `Backspace` to erase, `Up`/`Down` to move, `Space` to cycle visibility, `Esc` clears the filter first, then closes; the filter survives a trip to another tab |
| `Search` | type a query; skills.sh is searched as you type, `Up`/`Down` pick a result, `Enter` installs, `Esc` goes back to `Skills` |
| `Install` | type `owner/repo#skill`, `Enter` installs, `Esc` goes back to `Skills` |

Installation downloads the skill directory through the GitHub API into `~/.claude/skills/<skill>` after confirmation, then reloads the skill list and slash commands.

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

## Parallel curl

The built-in `curl` tool fetches up to 20 HTTP/HTTPS URLs with up to 8 concurrent `curl` processes. Each response is labeled with its URL and HTTP status; bodies are capped at 8 KB each. It requires confirmation unless `--yolo` is active.

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