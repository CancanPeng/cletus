import type {
  SearchParams,
  SearchProvider,
  SearchResponse,
  SearchSource,
} from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampLimit } from "./utils.js";

function apiKey(): string | undefined {
  return process.env["BRAVE_API_KEY"];
}

export const braveProvider: SearchProvider = {
  id: "brave",
  label: "Brave Search",
  isAvailable: () => Boolean(apiKey()),
  async search(params: SearchParams): Promise<SearchResponse> {
    const key = apiKey();
    if (!key) throw new SearchProviderError("brave", "BRAVE_API_KEY is not set");
    const query = new URLSearchParams({
      q: params.query,
      count: String(clampLimit(params.limit)),
      extra_snippets: "true",
      safesearch: "moderate",
    });
    if (params.recency) {
      query.set(
        "freshness",
        params.recency === "day" ? "pd" : params.recency === "week" ? "pw" : params.recency === "month" ? "pm" : "py",
      );
    }
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${query}`, {
      headers: {
        accept: "application/json",
        "x-subscription-token": key,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new SearchProviderError("brave", `Brave returned ${response.status}`, response.status);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const web = json["web"];
    const results =
      web && typeof web === "object" && "results" in web && Array.isArray(web.results)
        ? web.results
        : [];
    const sources: SearchSource[] = [];
    for (const raw of results) {
      if (!raw || typeof raw !== "object") continue;
      if (!("url" in raw) || typeof raw.url !== "string") continue;
      const title = "title" in raw && typeof raw.title === "string" ? raw.title : raw.url;
      const description = "description" in raw && typeof raw.description === "string" ? raw.description : undefined;
      const source: SearchSource = { title, url: raw.url };
      if (description) source.snippet = description;
      sources.push(source);
    }
    return {
      provider: "brave",
      sources: sources.slice(0, clampLimit(params.limit)),
    };
  },
};
