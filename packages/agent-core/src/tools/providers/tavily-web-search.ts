/**
 * TavilyWebSearchProvider — host-side `WebSearchProvider`.
 *
 * Mirrors the Python `_search_tavily` implementation: a POST to
 * `{baseUrl}/search` authenticated with a Bearer token. The request body
 * carries `{ query, max_results, include_raw_content }`; each `results[]`
 * entry maps to a `WebSearchResult` (title / url / content→snippet). When
 * `includeContent` is requested and Tavily returns `raw_content`, that full
 * page text is attached as the result `content`.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const ENV_API_KEY = 'TAVILY_API_KEY';

export interface TavilyWebSearchProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
}

interface TavilySearchBody {
  results?: TavilyResult[];
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;

  constructor(options: TavilyWebSearchProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.env = options.env ?? process.env;
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; provider?: string },
  ): Promise<WebSearchResult[]> {
    const apiKey = this.resolveApiKey();
    const limit = options?.limit ?? 5;
    const includeContent = options?.includeContent ?? false;

    const response = await this.fetchImpl(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        include_raw_content: includeContent,
      }),
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(`Tavily search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim());
    }
    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(`Tavily search request failed: HTTP ${String(response.status)}. ${detail}`.trim());
    }

    const json = (await response.json()) as TavilySearchBody;
    const raw = Array.isArray(json.results) ? json.results : [];

    return raw.slice(0, limit).map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
      };
      if (includeContent && typeof r.raw_content === 'string' && r.raw_content.length > 0) {
        out.content = r.raw_content;
      }
      return out;
    });
  }

  private resolveApiKey(): string {
    const key = nonEmpty(this.apiKey) ?? nonEmpty(this.env[ENV_API_KEY]);
    if (key === undefined) {
      throw new Error(
        `Tavily search is not configured: set the provider apiKey or the ${ENV_API_KEY} environment variable.`,
      );
    }
    return key;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
