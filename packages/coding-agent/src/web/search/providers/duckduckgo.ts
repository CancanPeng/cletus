import type {
  SearchParams,
  SearchProvider,
  SearchResponse,
  SearchSource,
} from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampLimit, decodeHtml, stripHtml } from "./utils.js";

export function parseDuckDuckGoHtml(html: string, limit: number): SearchSource[] {
  const sources: SearchSource[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(anchor)].filter((match) =>
    /class="[^"]*\bresult__a\b[^"]*"/i.test(match[1] ?? ""),
  );
  for (let index = 0; index < matches.length && sources.length < limit; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const href = /href="([^"]+)"/i.exec(match[1] ?? "");
    if (!href) continue;
    let url = decodeHtml(href[1] ?? "");
    if (url.startsWith("//")) url = `https:${url}`;
    try {
      const parsed = new URL(url, "https://duckduckgo.com");
      const redirect = parsed.searchParams.get("uddg");
      if (redirect) url = redirect;
    } catch {
      continue;
    }
    const title = stripHtml(match[2] ?? "");
    if (!title || !url.startsWith("http")) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1]?.index ?? html.length;
    const section = html.slice(start, next);
    const snippetMatch = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(
      section,
    );
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : undefined;
    const source: SearchSource = { title, url };
    if (snippet) source.snippet = snippet;
    sources.push(source);
  }
  return sources;
}

export const duckDuckGoProvider: SearchProvider = {
  id: "duckduckgo",
  label: "DuckDuckGo",
  isAvailable: () => true,
  async search(params: SearchParams): Promise<SearchResponse> {
    const body = new URLSearchParams({
      q: params.query,
      kl: "us-en",
    });
    if (params.recency) {
      body.set("df", params.recency === "day" ? "d" : params.recency === "week" ? "w" : params.recency === "month" ? "m" : "y");
    }
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      body,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new SearchProviderError(
        "duckduckgo",
        `DuckDuckGo returned ${response.status}`,
        response.status,
      );
    }
    const html = await response.text();
    if (/anomaly-modal|If this error persists/i.test(html)) {
      throw new SearchProviderError("duckduckgo", "DuckDuckGo blocked the request", 429);
    }
    const limit = clampLimit(params.limit);
    return {
      provider: "duckduckgo",
      sources: parseDuckDuckGoHtml(html, limit),
    };
  },
};
