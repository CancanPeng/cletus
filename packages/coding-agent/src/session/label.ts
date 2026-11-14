import type { SessionInfo } from "./types.js";

const PREVIEW_LIMIT = 50;

export function sessionLabel(info: SessionInfo, isCurrent = false): string {
  const when = new Date(info.timestamp).toLocaleString();
  const text = info.firstUserText.replace(/\s+/g, " ").trim();
  const preview =
    text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
  const count = `${info.messageCount} msg`;
  const parts = [when, count];
  parts.push(preview || "(empty session)");
  if (isCurrent) parts.push("current");
  return parts.join(" · ");
}