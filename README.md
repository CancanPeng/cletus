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

Read tools are confined to the working directory plus configured skill/prompt roots. Writes and command execution require confirmation. `--yolo` disables confirmations; use it only in trusted workspaces. Non-interactive `-p`/`--json` runs deny writes and commands unless `--yolo` is passed or the write path matches the persistent allowlist below.

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
| Cmd+V / Ctrl+Shift+V / Ctrl+V | paste text or an image (png/jpeg, ≤5MB) from the host clipboard |
| Tab | complete slash command |
| Up/Down | history (empty input) |

Override bindings in `~/.cletus/config.json` under `tui.keybindings`, for example:

```json
{ "tui": { "theme": "tokyo-night", "keybindings": { "abort": "ctrl+x" } } }
```

Keybinding changes apply on the next launch. `/theme` switches and persists immediately.

## Images

Paste a screenshot with the paste key: it is saved next to the session file and a `[图片 #N]` placeholder appears in the input. Send it with your question; up to 10 images per message, 5MB each. Images are stored as file references in the session log, so `/resume` keeps them.

Known limits: images are re-sent with the full history on every turn, so many large screenshots across many turns can hit the provider's request size limit (~32MB on Anthropic); use `/compact` or `/new` when that happens. Models marked `"supportsImages": false` in `~/.cletus/config.json` get a text placeholder instead of the image.

The `read` tool also sees images: reading a `.png` or `.jpeg` returns the picture to the model along with a one-line summary (format, pixel size, absolute path), so it can inspect a screenshot in your project without you pasting it. Files are detected by content, not extension. The 5MB per-image limit applies here too, and images over it are rejected rather than truncated. Non-vision models get the summary plus an ignored-image placeholder.

## Status bar

Icons (unicode preset shown; the default `nerd` preset uses Nerd Font glyphs): `◈` model, `⌂` cwd, `⎇` git branch, `✓` ready, `◷` duration, `▤` context usage, `≡` queued, `▲` YOLO, `⚑` permission, `❖` skills manager.

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

`/help`, `/quit`, `/new`, `/resume`, `/fork`, `/compact`, `/model`, `/theme`, `/symbols`, `/keys`, `/skills`, `/permissions`, `/yolo`, `/verbose`, `/thinking`, `/mcp`, `/reload`, plus each user-invocable skill by its own name (for example `/using-git-worktrees`) and prompt templates from `~/.cletus/prompts` and `.cletus/prompts`.

## Sessions

`/new` opens a fresh session in the current directory, `/resume` lists the sessions recorded for it, and `/fork` branches an existing conversation. All three refuse to run while the agent is working.

`/resume` restores the conversation into the transcript, not just into context, and marks the session you are already in with `current`. Sessions are per-directory, newest first. Non-interactive equivalents:

```bash
cletus --continue            # reopen the most recent session here
cletus --resume <id|path>    # reopen a specific one (full id, unique short prefix, or file path)
cletus sessions list         # ids to pass to --resume
```

## Forking

`/fork` copies the current conversation into a new session file and switches to it, leaving the original untouched (`cletus --resume <id>` still reaches it).

The picker lists the current position first, then each of your messages newest first. Choosing `Now` clones the whole branch; choosing an earlier message clones only what came before it, so the rest is dropped from the new session and the transcript rewinds to match. Tool calls are replayed with their results, and a call cut off by the fork point is shown as an error.

Forking is refused while the agent is running.
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

The built-in `curl` tool fetches up to 20 HTTP/HTTPS URLs with up to 8 concurrent `curl` processes. Each response is labeled with its URL and HTTP status; bodies are capped at 8,000 characters each. It requires confirmation unless `--yolo` is active.

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
- Skills: `~/.cletus/skills`, `~/.agents/skills`, `~/.claude/skills` always load. Project skills (`.cletus/skills`, `.agents/skills`, `.claude/skills` in the project and ancestors) require project trust.
- Prompt templates: `~/.cletus/prompts/*.md` always load; `.cletus/prompts/*.md` requires project trust.
- Extensions: `~/.cletus/extensions/*.ts`, `.cletus/extensions/*.ts` (requires project trust).
- MCP: `~/.cletus/mcp.json`, `.cletus/mcp.json` (project servers require trust). Servers connect in the background, so the TUI opens immediately; `MCP ready` appears when tools are registered.

Project trust is requested on first interactive run in a directory that has `.cletus` resources, or granted with `--trust`. Untrusted project resources are ignored, so a cloned repository cannot inject instructions, tools, or commands without your approval.

## License

MIT