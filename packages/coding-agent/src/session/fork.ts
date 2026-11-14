import type { SessionManager } from "./manager.js";

export type ForkChoice = {
  /** Label shown in the picker. */
  label: string;
  /** Session entry to fork from; empty string means the current leaf. */
  value: string;
};

const PREVIEW_LIMIT = 72;

/**
 * Fork points offered by `/fork`: the current position first, then each user
 * message newest first, so the closest rewrite point is one keypress away.
 */
export function forkChoices(manager: SessionManager): ForkChoice[] {
  const choices: ForkChoice[] = [
    { value: "", label: "Now · keep the whole conversation" },
  ];
  const points: ForkChoice[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = entry.message.content.replace(/\s+/g, " ").trim();
    const preview =
      text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
    points.push({ value: entry.id, label: preview || "(empty message)" });
  }
  points.reverse();
  return [...choices, ...points];
}

export type ForkOutcome =
  | { status: "forked"; manager: SessionManager }
  | { status: "cancelled" }
  | { status: "busy" };

/** `/fork`: ask where to branch, then clone that branch into a new session. */
export async function runFork(options: {
  manager: SessionManager;
  isStreaming: boolean;
  select: (title: string, items: ForkChoice[]) => Promise<string | undefined>;
}): Promise<ForkOutcome> {
  // Forking mid-turn would clone a half-written tool call into the new file.
  if (options.isStreaming) return { status: "busy" };
  const choice = await options.select("Fork at", forkChoices(options.manager));
  if (choice === undefined) return { status: "cancelled" };
  const manager = await options.manager.fork(choice || undefined);
  return { status: "forked", manager };
}