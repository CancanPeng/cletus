import { describe, expect, it } from "vitest";
import {
  filterSources,
  parseQueryConstraints,
  searchWeb,
  type SearchProvider,
} from "../src/web/search/index.js";
import { parseDuckDuckGoHtml } from "../src/web/search/providers/duckduckgo.js";
import { parseParallelText } from "../src/web/search/providers/parallel.js";
import { parseExaText } from "../src/web/search/providers/exa.js";
import { parseFirecrawl } from "../src/web/search/providers/firecrawl.js";
import { createWebSearchTool } from "../src/tools/web-search.js";
import { createCoreTools } from "../src/tools/index.js";
import { PermissionPolicy } from "../src/permissions/policy.js";

const config = { enabled: true, order: ["a", "b"], timeoutSeconds: 5 };

describe("web search", () => {
  it("parses DuckDuckGo HTML results and redirects", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example &amp; A</a>
      <a class="result__snippet">Snippet <b>one</b></a>
      <a class="result__a" href="https://example.org/b">Example B</a>
      <div class="result__snippet">Snippet two</div>
    `;
    expect(parseDuckDuckGoHtml(html, 10)).toEqual([
      {
        title: "Example & A",
        url: "https://example.com/a",
        snippet: "Snippet one",
      },
      { title: "Example B", url: "https://example.org/b", snippet: "Snippet two" },
    ]);
  });

  it("parses keyless provider results", () => {
    expect(
      parseParallelText(
        JSON.stringify({
          search_id: "search_1",
          results: [
            {
              title: "Parallel result",
              url: "https://example.com/p",
              excerpts: ["Parallel snippet"],
            },
          ],
        }),
        5,
      ),
    ).toEqual([
      {
        title: "Parallel result",
        url: "https://example.com/p",
        snippet: "Parallel snippet",
      },
    ]);
    expect(
      parseExaText(
        "Title: Exa result\nURL: https://example.com/e\nPublished: N/A\nHighlights:\nExa snippet\n---\n",
        5,
      ),
    ).toEqual([
      { title: "Exa result", url: "https://example.com/e", snippet: "Exa snippet" },
    ]);
    expect(
      parseFirecrawl(
        {
          success: true,
          data: {
            web: [
              {
                title: "Firecrawl result",
                url: "https://example.com/f",
                description: "Firecrawl snippet",
              },
            ],
          },
        },
        5,
      ),
    ).toEqual([
      {
        title: "Firecrawl result",
        url: "https://example.com/f",
        snippet: "Firecrawl snippet",
      },
    ]);
  });

  it("falls back to the next provider", async () => {
    const failing: SearchProvider = {
      id: "a",
      label: "A",
      isAvailable: () => true,
      search: async () => {
        throw new Error("boom");
      },
    };
    const working: SearchProvider = {
      id: "b",
      label: "B",
      isAvailable: () => true,
      search: async () => ({
        provider: "b",
        sources: [{ title: "B", url: "https://example.com/b" }],
      }),
    };
    const response = await searchWeb(
      { query: "hello", limit: 5 },
      [failing, working],
      config,
    );
    expect(response.provider).toBe("b");
  });

  it("applies site and filetype constraints", () => {
    const constraints = parseQueryConstraints(
      "rust site:docs.rs filetype:html -site:example.com",
    );
    expect(constraints).toEqual({
      includeSites: ["docs.rs"],
      excludeSites: ["example.com"],
      includeFileTypes: ["html"],
    });
    expect(
      filterSources(
        [
          { title: "ok", url: "https://docs.rs/foo.html" },
          { title: "wrong host", url: "https://example.org/foo.html" },
          { title: "wrong type", url: "https://docs.rs/foo.pdf" },
        ],
        constraints,
      ).map((source) => source.title),
    ).toEqual(["ok"]);
  });

  it("registers the web_search tool", async () => {
    const policy = new PermissionPolicy({
      cwd: process.cwd(),
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const base = {
      provider: "openai" as const,
      id: "fake",
      baseUrl: "http://localhost",
      contextWindow: 1000,
      maxOutputTokens: 100,
    };
    const client = createCoreTools({
      cwd: process.cwd(),
      policy,
      home: process.cwd(),
      model: base,
      sessionId: "1",
      webSearch: config,
    });
    expect(client.some((tool) => tool.name === "web_search")).toBe(true);
  });

  it("returns a formatted tool result", async () => {
    const provider: SearchProvider = {
      id: "fake",
      label: "Fake",
      isAvailable: () => true,
      search: async () => ({
        provider: "fake",
        answer: "Answer",
        sources: [{ title: "Source", url: "https://example.com", snippet: "Text" }],
      }),
    };
    const tool = createWebSearchTool({ config, providers: [provider] });
    const result = await tool.execute(
      { query: "q" },
      {
        cwd: process.cwd(),
        toolCallId: "1",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("Answer");
    expect(result.content[0]?.text).toContain("https://example.com");
  });
});
