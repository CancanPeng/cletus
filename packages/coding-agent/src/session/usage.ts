import type { AgentMessage } from "@cletus/agent";

export type UsageStats = {
  /** Assistant messages that reported usage (one per model call). */
  calls: number;
  /** Input tokens sent, normalized so cached tokens are counted once. */
  promptTokens: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Prompt tokens not served from the cache (fresh input + cache writes). */
  cacheMiss: number;
  totalTokens: number;
  /** cacheRead / promptTokens; 0 when there are no calls. */
  hitRate: number;
};

/**
 * Aggregates per-call usage across a session. Providers report differently:
 * Anthropic's `input` excludes cache reads/writes, OpenAI's includes cached
 * tokens, so each call is normalized to prompt = all input tokens sent.
 */
export function summarizeUsage(messages: AgentMessage[]): UsageStats {
  const stats: UsageStats = {
    calls: 0,
    promptTokens: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheMiss: 0,
    totalTokens: 0,
    hitRate: 0,
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    // Error placeholders carry empty usage; counting them would dilute the
    // hit rate with calls that never reached the model.
    if (usage.totalTokens <= 0) continue;
    const overlap = message.provider === "openai" ? usage.cacheRead : 0;
    const prompt = Math.max(
      0,
      usage.input + usage.cacheWrite + usage.cacheRead - overlap,
    );
    stats.calls += 1;
    stats.promptTokens += prompt;
    stats.output += usage.output;
    stats.cacheRead += usage.cacheRead;
    stats.cacheWrite += usage.cacheWrite;
    stats.cacheMiss += prompt - usage.cacheRead;
    stats.totalTokens += usage.totalTokens;
  }
  stats.hitRate = stats.promptTokens > 0 ? stats.cacheRead / stats.promptTokens : 0;
  return stats;
}

export function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** Multi-line /context report: window usage, token totals, cache hit/miss. */
export function contextReport(
  context: { used: number; window: number },
  stats: UsageStats,
): string {
  const percent =
    context.window > 0
      ? Math.min(100, Math.round((context.used / context.window) * 100))
      : 0;
  const lines = [
    `Context: ${shortTokens(context.used)}/${shortTokens(context.window)} (${percent}%)`,
  ];
  if (stats.calls === 0) {
    lines.push("Tokens: no model calls yet");
    return lines.join("\n");
  }
  lines.push(
    `Tokens: input ${shortTokens(stats.promptTokens)} · output ${shortTokens(stats.output)} · total ${shortTokens(stats.totalTokens)} (${stats.calls} calls)`,
  );
  lines.push(
    `Cache: hit ${shortTokens(stats.cacheRead)} · miss ${shortTokens(stats.cacheMiss)} · write ${shortTokens(stats.cacheWrite)} · hit rate ${(stats.hitRate * 100).toFixed(1)}%`,
  );
  return lines.join("\n");
}
