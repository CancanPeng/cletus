import type { SearchParams, SearchProvider, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampLimit } from "./utils.js";

function apiKey(): string | undefined {
  return process.env["TAVILY_API_KEY"];
}

export const tavilyProvider: SearchProvider = {
  id: "tavily",
  label: "Tavily",
  isAvailable: () => Boolean(apiKey()),
  async search(params: SearchParams): Promise<SearchResponse> {
    const key = apiKey();
    if (!key) throw new SearchProviderError("tavily", "TAVILY_API_KEY is not set");
    const body: Record<string, unknown> = {
      api_key: key,
      query: params.query,
      max_results: clampLimit(params.limit),
    };
    if (params.recency) body["time_range"] = params.recency;
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new SearchProviderError("tavily", `Tavily returned ${response.status}`, response.status);
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
    const responseOut: SearchResponse = { provider: "tavily", sources };
    if (typeof json["answer"] === "string") responseOut.answer = json["answer"];
    if (typeof json["request_id"] === "string") responseOut.requestId = json["request_id"];
    return responseOut;
  },
};
