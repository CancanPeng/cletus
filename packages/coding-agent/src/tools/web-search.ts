import type { AgentTool, ToolResult } from "@cletus/agent";
import type { WebSearchConfig } from "../config.js";
import {
  defaultProviders,
  filterSources,
  formatSearchResponse,
  parseQueryConstraints,
  searchWeb,
  type SearchProvider,
  type SearchRecency,
} from "../web/search/index.js";

const RECENCY: Record<string, SearchRecency> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

export function createWebSearchTool(deps: {
  config: WebSearchConfig;
  providers?: SearchProvider[];
}): AgentTool {
  return {
    name: "web_search",
    snippet: "Search the web and return sources",
    description:
      "Search the web through the configured provider chain and return titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency filter",
        },
        limit: { type: "number", description: "Maximum results (default 10, max 20)" },
        num_search_results: { type: "number", description: "Alias for limit" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(params, ctx): Promise<ToolResult> {
      const query = String(params["query"] ?? "").trim();
      if (!query) {
        return {
          isError: true,
          content: [{ type: "text", text: "web_search requires a query" }],
        };
      }
      const rawLimit = Number(params["num_search_results"] ?? params["limit"] ?? 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), 20)
        : 10;
      const recencyValue = String(params["recency"] ?? "");
      const recency = RECENCY[recencyValue];
      const providers = deps.providers ?? defaultProviders(deps.config.order);
      try {
        const response = await searchWeb(
          {
            query,
            limit,
            ...(recency ? { recency } : {}),
            signal: ctx.signal,
          },
          providers,
          deps.config,
        );
        const constraints = parseQueryConstraints(query);
        const filtered = filterSources(response.sources, constraints);
        const relaxed =
          filtered.length === 0 &&
          (constraints.includeSites.length > 0 ||
            constraints.excludeSites.length > 0 ||
            constraints.includeFileTypes.length > 0);
        const sources = relaxed ? response.sources : filtered;
        const text = formatSearchResponse({ ...response, sources });
        return {
          content: [
            {
              type: "text",
              text: text || "No results found",
            },
          ],
          details: {
            provider: response.provider,
            sources,
            ...(response.answer ? { answer: response.answer } : {}),
            ...(relaxed ? { relaxed: true } : {}),
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
