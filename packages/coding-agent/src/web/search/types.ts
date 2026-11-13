export type SearchRecency = "day" | "week" | "month" | "year";

export type SearchParams = {
  query: string;
  recency?: SearchRecency;
  limit: number;
  signal?: AbortSignal;
};

export type SearchSource = {
  title: string;
  url: string;
  snippet?: string;
};

export type SearchResponse = {
  provider: string;
  sources: SearchSource[];
  answer?: string;
  requestId?: string;
};

export class SearchProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  isAvailable(): boolean;
  search(params: SearchParams): Promise<SearchResponse>;
}
