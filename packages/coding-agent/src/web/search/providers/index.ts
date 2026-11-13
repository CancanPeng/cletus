import type { SearchProvider } from "../types.js";
import { braveProvider } from "./brave.js";
import { duckDuckGoProvider } from "./duckduckgo.js";
import { searxngProvider } from "./searxng.js";
import { tavilyProvider } from "./tavily.js";

const PROVIDERS: Record<string, SearchProvider> = {
  brave: braveProvider,
  tavily: tavilyProvider,
  searxng: searxngProvider,
  duckduckgo: duckDuckGoProvider,
};

export function getProvider(id: string): SearchProvider | undefined {
  return PROVIDERS[id];
}

export function defaultProviders(order: string[]): SearchProvider[] {
  return order
    .map((id) => getProvider(id))
    .filter((provider): provider is SearchProvider => provider !== undefined);
}

export { braveProvider, duckDuckGoProvider, searxngProvider, tavilyProvider };
