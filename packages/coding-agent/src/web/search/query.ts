import type { SearchSource } from "./types.js";

export type QueryConstraints = {
  includeSites: string[];
  excludeSites: string[];
  includeFileTypes: string[];
};

export function parseQueryConstraints(query: string): QueryConstraints {
  const includeSites: string[] = [];
  const excludeSites: string[] = [];
  const includeFileTypes: string[] = [];
  const tokenPattern = /(^|\s)(-?site:)([^\s]+)|(^|\s)filetype:([^\s]+)/gi;
  for (const match of query.matchAll(tokenPattern)) {
    if (match[2] === "site:" && match[3]) includeSites.push(match[3].toLowerCase());
    else if (match[2] === "-site:" && match[3]) excludeSites.push(match[3].toLowerCase());
    else if (match[5]) includeFileTypes.push(match[5].toLowerCase());
  }
  return {
    includeSites,
    excludeSites,
    includeFileTypes,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesSite(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

export function filterSources(
  sources: SearchSource[],
  constraints: QueryConstraints,
): SearchSource[] {
  return sources.filter((source) => {
    const host = hostOf(source.url);
    if (!host) return false;
    if (constraints.includeSites.length > 0) {
      if (!constraints.includeSites.some((site) => matchesSite(host, site))) return false;
    }
    if (constraints.excludeSites.some((site) => matchesSite(host, site))) return false;
    if (constraints.includeFileTypes.length > 0) {
      const path = source.url.toLowerCase();
      if (!constraints.includeFileTypes.some((type) => path.includes(`.${type}`))) return false;
    }
    return true;
  });
}
