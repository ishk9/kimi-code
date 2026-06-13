import { describe, expect, it, vi } from 'vitest';

import { BraveWebSearchProvider } from '../../../src/tools/providers/brave-web-search';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SAMPLE = {
  web: {
    results: [
      { title: 'T1', url: 'https://1.example', description: 'd1', page_age: '2024-01-01' },
      { title: 'T2', url: 'https://2.example', description: 'd2' },
    ],
  },
};

describe('BraveWebSearchProvider', () => {
  it('maps web.results[] to WebSearchResult[]', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new BraveWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    const results = await provider.search('cats');

    expect(results).toEqual([
      { title: 'T1', url: 'https://1.example', snippet: 'd1', date: '2024-01-01' },
      { title: 'T2', url: 'https://2.example', snippet: 'd2' },
    ]);
  });

  it('sends the subscription header and q/count query params', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new BraveWebSearchProvider({ apiKey: 'brave-token', fetchImpl, env: {} });

    await provider.search('cats', { limit: 3 });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsed = new URL(typeof url === 'string' ? url : '');
    expect(parsed.origin + parsed.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(parsed.searchParams.get('q')).toBe('cats');
    expect(parsed.searchParams.get('count')).toBe('3');
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-token');
  });

  it('falls back to BRAVE_API_KEY when the configured apiKey is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new BraveWebSearchProvider({ fetchImpl, env: { BRAVE_API_KEY: 'env-token' } });

    await provider.search('cats');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('env-token');
  });

  it('throws a clear error when no api key is available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new BraveWebSearchProvider({ fetchImpl, env: {} });

    await expect(provider.search('cats')).rejects.toThrow(/BRAVE_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
