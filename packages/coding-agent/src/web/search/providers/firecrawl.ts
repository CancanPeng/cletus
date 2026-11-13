import type { SearchParams, SearchProvider, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampLimit } from "./utils.js";

export function parseFirecrawl(json: Record<string, unknown>, limit: number): SearchSource[] {
  const data = json["data"];
  const web =
    data && typeof data === "object" && "web" in data && Array.isArray(data.web)
      ? data.web
      : [];
  const sources: SearchSource[] = [];
  for (const raw of web) {
    if (!raw || typeof raw !== "object") continue;
    if (!("url" in raw) || typeof raw.url !== "string") continue;
    const source: SearchSource = {
      title: "title" in raw && typeof raw.title === "string" ? raw.title : raw.url,
      url: raw.url,
    };
    if ("description" in raw && typeof raw.description === "string") {
      source.snippet = raw.description;
    }
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

export const firecrawlProvider: SearchProvider = {
  id: "firecrawl",
  label: "Firecrawl",
  isAvailable: () => true,
  async search(params: SearchParams): Promise<SearchResponse> {
    const limit = clampLimit(params.limit, 100, 10);
    const key = process.env["FIRECRAWL_API_KEY"];
    const response = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        query: params.query,
        sources: [{ type: "web" }],
        limit,
        ...(params.recency ? { tbs: params.recency === "day" ? "qdr:d" : params.recency === "week" ? "qdr:w" : params.recency === "month" ? "qdr:m" : "qdr:y" } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new SearchProviderError(
        "firecrawl",
        `Firecrawl returned ${response.status}`,
        response.status,
      );
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (json["success"] === false) {
      throw new SearchProviderError("firecrawl", "Firecrawl search failed");
    }
    return {
      provider: "firecrawl",
      sources: parseFirecrawl(json, limit),
    };
  },
};
