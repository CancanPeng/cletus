import type { SearchParams, SearchProvider, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { callMcpTool } from "./mcp.js";
import { clampLimit } from "./utils.js";

export function parseExaText(text: string, limit: number): SearchSource[] {
  const sources: SearchSource[] = [];
  for (const chunk of text.split(/\n\s*---\s*\n/)) {
    const title = /^Title:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
    const url = /^URL:\s*(\S+)$/m.exec(chunk)?.[1]?.trim();
    if (!title || !url) continue;
    const highlights = /Highlights:\s*\n([\s\S]*?)(?:\n\s*---|$)/.exec(chunk)?.[1]?.trim();
    const source: SearchSource = { title, url };
    if (highlights) source.snippet = highlights;
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

export const exaProvider: SearchProvider = {
  id: "exa",
  label: "Exa",
  isAvailable: () => true,
  async search(params: SearchParams): Promise<SearchResponse> {
    const limit = clampLimit(params.limit, 20, 10);
    const text = await callMcpTool(
      "https://mcp.exa.ai/mcp",
      "web_search_exa",
      {
        query: params.query,
        objective: `Find the most relevant web pages for: ${params.query}`.slice(0, 4096),
        numResults: limit,
      },
      params.signal,
    );
    const sources = parseExaText(text, limit);
    if (sources.length === 0) {
      throw new SearchProviderError("exa", "Exa returned no parsable results");
    }
    return { provider: "exa", sources };
  },
};
