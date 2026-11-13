import type { WebSearchConfig } from "../../config.js";
import type { SearchParams, SearchProvider, SearchResponse } from "./types.js";

export * from "./types.js";
export { defaultProviders, getProvider } from "./providers/index.js";
export { filterSources, parseQueryConstraints } from "./query.js";

export type SearchRequest = {
  query: string;
  recency?: SearchParams["recency"];
  limit: number;
  signal?: AbortSignal;
};

function timeoutSignal(seconds: number): AbortSignal {
  const bounded = Math.min(Math.max(seconds, 1), 300);
  return AbortSignal.timeout(bounded * 1000);
}

export async function searchWeb(
  request: SearchRequest,
  providers: SearchProvider[],
  config: WebSearchConfig,
): Promise<SearchResponse> {
  if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const available = providers.filter((provider) => provider.isAvailable());
  if (available.length === 0) {
    throw new Error(
      "No web search provider configured. Set BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_ENDPOINT.",
    );
  }
  const failures: string[] = [];
  for (const provider of available) {
    const timeout = timeoutSignal(config.timeoutSeconds);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    try {
      const response = await provider.search({
        query: request.query,
        limit: request.limit,
        ...(request.recency ? { recency: request.recency } : {}),
        signal,
      });
      if (response.answer || response.sources.length > 0) return response;
      failures.push(`${provider.id}: no results`);
    } catch (error) {
      if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const message =
        error instanceof Error ? error.message : String(error);
      failures.push(`${provider.id}: ${message}`);
    }
  }
  throw new Error(
    failures.length === 1
      ? `Web search failed: ${failures[0]}`
      : `All web search providers failed: ${failures.join("; ")}`,
  );
}

export function formatSearchResponse(response: SearchResponse): string {
  const lines: string[] = [];
  if (response.answer) lines.push(response.answer.trim());
  if (response.sources.length > 0) {
    if (lines.length > 0) lines.push("", `## Sources (${response.sources.length})`);
    response.sources.forEach((source, index) => {
      lines.push(`[${index + 1}] ${source.title}`);
      lines.push(`    ${source.url}`);
      if (source.snippet) {
        const snippet = source.snippet.replace(/\s+/g, " ").trim().slice(0, 240);
        if (snippet) lines.push(`    ${snippet}`);
      }
    });
  }
  return lines.join("\n").trim();
}
