import { marked, type Token, type Tokens } from "marked";
import type { Theme } from "./theme.js";
import { wrapText } from "./utils.js";

function renderInline(tokens: Token[] | undefined, theme: Theme): string {
  if (!tokens) return "";
  let result = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        result += token.tokens ? renderInline(token.tokens, theme) : token.text;
        break;
      case "escape":
        result += token.text;
        break;
      case "strong":
        result += `\x1b[1m${renderInline(token.tokens, theme)}\x1b[22m`;
        break;
      case "em":
        result += `\x1b[3m${renderInline(token.tokens, theme)}\x1b[23m`;
        break;
      case "del":
        result += `\x1b[9m${renderInline(token.tokens, theme)}\x1b[29m`;
        break;
      case "codespan":
        result += `\x1b[7m${theme.style("code", token.text)}\x1b[27m`;
        break;
      case "br":
        result += "\n";
        break;
      case "link":
        result += `${renderInline(token.tokens, theme)} (${token.href})`;
        break;
      case "image":
        result += `${token.text} (${token.href})`;
        break;
      case "html":
        break;
      default:
        if ("text" in token && typeof token.text === "string") result += token.text;
        break;
    }
  }
  return result;
}

function appendWrapped(lines: string[], text: string, width: number): void {
  lines.push(...wrapText(text, width));
}

export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  const tokens = marked.lexer(text);
  const lines: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const title = `${"#".repeat(token.depth)} ${renderInline(token.tokens, theme)}`;
        lines.push(`\x1b[1m${title}\x1b[22m`);
        break;
      }
      case "paragraph":
        appendWrapped(lines, renderInline(token.tokens, theme), width);
        break;
      case "text":
        appendWrapped(lines, renderInline(token.tokens, theme), width);
        break;
      case "code": {
        lines.push(theme.style("muted", `  ${token.lang ?? ""}`.trimEnd()));
        for (const line of token.text.split("\n")) {
          lines.push(`${theme.style("muted", "│ ")}${theme.style("code", line)}`);
        }
        break;
      }
      case "list": {
        token.items.forEach((item: Tokens.ListItem, index: number) => {
          const marker = token.ordered ? `${(token.start || 1) + index}. ` : "• ";
          const body = item.tokens
            .map((child) =>
              child.type === "text"
                ? renderInline(child.tokens, theme) || child.text
                : child.type === "paragraph"
                  ? renderInline(child.tokens, theme)
                  : "",
            )
            .join(" ")
            .trim();
          appendWrapped(lines, `${marker}${body}`, width);
        });
        break;
      }
      case "blockquote": {
        const inner = renderMarkdown(token.text, Math.max(1, width - 2), theme);
        for (const line of inner) lines.push(`${theme.style("muted", "> ")}${line}`);
        break;
      }
      case "table": {
        const header = token.header.map((cell: Tokens.TableCell) => renderInline(cell.tokens, theme));
        lines.push(header.join(" | "));
        for (const row of token.rows) {
          lines.push(row.map((cell: Tokens.TableCell) => renderInline(cell.tokens, theme)).join(" | "));
        }
        break;
      }
      case "hr":
        lines.push(theme.style("border", "─".repeat(width)));
        break;
      case "space":
        break;
      default:
        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          appendWrapped(lines, token.text, width);
        }
        break;
    }
  }
  return lines;
}