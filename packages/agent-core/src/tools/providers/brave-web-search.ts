/**
 * BraveWebSearchProvider — host-side `WebSearchProvider`.
 *
 * Mirrors the Python `_search_brave` implementation: a GET against
 * `{baseUrl}/web/search` authenticated with the `X-Subscription-Token`
 * header. Each `web.results[]` entry maps to a `WebSearchResult`
 * (title / url / description→snippet / page_age→date).
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1';
const ENV_API_KEY = 'BRAVE_API_KEY';

export interface BraveWebSearchProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

interface BraveSearchBody {
  web?: { results?: BraveWebResult[] };
}

export class BraveWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;

  constructor(options: BraveWebSearchProviderOptions = {}) {
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

    const url = new URL(`${this.baseUrl}/web/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        ...this.defaultHeaders,
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(`Brave search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim());
    }
    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(`Brave search request failed: HTTP ${String(response.status)}. ${detail}`.trim());
    }

    const json = (await response.json()) as BraveSearchBody;
    const raw = Array.isArray(json.web?.results) ? json.web.results : [];

    return raw.slice(0, limit).map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
      };
      if (typeof r.page_age === 'string' && r.page_age.length > 0) out.date = r.page_age;
      return out;
    });
  }

  private resolveApiKey(): string {
    const key = nonEmpty(this.apiKey) ?? nonEmpty(this.env[ENV_API_KEY]);
    if (key === undefined) {
      throw new Error(
        `Brave search is not configured: set the provider apiKey or the ${ENV_API_KEY} environment variable.`,
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
