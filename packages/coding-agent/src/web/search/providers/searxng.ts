import type { SearchParams, SearchProvider, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampLimit } from "./utils.js";

function endpoint(): string | undefined {
  return process.env["SEARXNG_ENDPOINT"];
}

export const searxngProvider: SearchProvider = {
  id: "searxng",
  label: "SearXNG",
  isAvailable: () => Boolean(endpoint()),
  async search(params: SearchParams): Promise<SearchResponse> {
    const base = endpoint();
    if (!base) throw new SearchProviderError("searxng", "SEARXNG_ENDPOINT is not set");
    const query = new URLSearchParams({
      format: "json",
      q: params.query,
    });
    if (params.recency) {
      query.set("time_range", params.recency === "week" ? "month" : params.recency);
    }
    const response = await fetch(`${base.replace(/\/$/, "")}/search?${query}`, {
      headers: { accept: "application/json" },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new SearchProviderError("searxng", `SearXNG returned ${response.status}`, response.status);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const results = Array.isArray(json["results"]) ? json["results"] : [];
    const sources: SearchSource[] = [];
    for (const raw of results) {
      if (!raw || typeof raw !== "object") continue;
      if (!("url" in raw) || typeof raw.url !== "string") continue;
      const source: SearchSource = {
        title: "title" in raw && typeof raw.title === "string" ? raw.title : raw.url,
        url: raw.url,
      };
      if ("content" in raw && typeof raw.content === "string") source.snippet = raw.content;
      sources.push(source);
    }
    return {
      provider: "searxng",
      sources: sources.slice(0, clampLimit(params.limit)),
    };
  },
};
