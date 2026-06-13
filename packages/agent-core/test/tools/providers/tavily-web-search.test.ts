import { describe, expect, it, vi } from 'vitest';

import { TavilyWebSearchProvider } from '../../../src/tools/providers/tavily-web-search';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function urlOf(arg: unknown): string {
  return typeof arg === 'string' ? arg : '';
}

function bodyJson(body: unknown): Record<string, unknown> {
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

const SAMPLE = {
  results: [
    { title: 'T1', url: 'https://1.example', content: 'c1', raw_content: 'raw1' },
    { title: 'T2', url: 'https://2.example', content: 'c2' },
  ],
};

describe('TavilyWebSearchProvider', () => {
  it('maps results[] to WebSearchResult[] (content → snippet)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new TavilyWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    const results = await provider.search('cats');

    expect(results).toEqual([
      { title: 'T1', url: 'https://1.example', snippet: 'c1' },
      { title: 'T2', url: 'https://2.example', snippet: 'c2' },
    ]);
  });

  it('attaches raw_content as content only when includeContent is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new TavilyWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    const results = await provider.search('cats', { includeContent: true });

    expect(results[0]?.content).toBe('raw1');
    expect(results[1]?.content).toBeUndefined();
  });

  it('sends bearer auth and the documented body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new TavilyWebSearchProvider({ apiKey: 'tavily-key', fetchImpl, env: {} });

    await provider.search('cats', { limit: 7, includeContent: true });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('https://api.tavily.com/search');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tavily-key');
    const body = bodyJson(init?.body);
    expect(body).toEqual({ query: 'cats', max_results: 7, include_raw_content: true });
  });

  it('falls back to TAVILY_API_KEY when the configured apiKey is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new TavilyWebSearchProvider({ fetchImpl, env: { TAVILY_API_KEY: 'env-key' } });

    await provider.search('cats');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer env-key');
  });

  it('throws a clear error when no api key is available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new TavilyWebSearchProvider({ fetchImpl, env: {} });

    await expect(provider.search('cats')).rejects.toThrow(/TAVILY_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
