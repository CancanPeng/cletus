import type { SearchParams, SearchProvider, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { callMcpTool } from "./mcp.js";
import { clampLimit } from "./utils.js";

export function parseParallelText(text: string, limit: number): SearchSource[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const results = Array.isArray(parsed["results"]) ? parsed["results"] : [];
  const sources: SearchSource[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    if (!("url" in raw) || typeof raw.url !== "string") continue;
    const source: SearchSource = {
      title: "title" in raw && typeof raw.title === "string" ? raw.title : raw.url,
      url: raw.url,
    };
    if ("excerpts" in raw && Array.isArray(raw.excerpts)) {
      const excerpt = raw.excerpts.find((item: unknown): item is string => typeof item === "string");
      if (excerpt) source.snippet = excerpt.slice(0, 4000);
    }
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

export const parallelProvider: SearchProvider = {
  id: "parallel",
  label: "Parallel",
  isAvailable: () => true,
  async search(params: SearchParams): Promise<SearchResponse> {
    const limit = clampLimit(params.limit, 20, 10);
    const text = await callMcpTool(
      "https://search.parallel.ai/mcp",
      "web_search",
      {
        objective: params.query,
        search_queries: [params.query],
      },
      params.signal,
    );
    try {
      const sources = parseParallelText(text, limit);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const response: SearchResponse = { provider: "parallel", sources };
      if (typeof parsed["search_id"] === "string") response.requestId = parsed["search_id"];
      return response;
    } catch (error) {
      throw new SearchProviderError(
        "parallel",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};
