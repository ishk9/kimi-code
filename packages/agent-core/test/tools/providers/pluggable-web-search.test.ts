import { describe, expect, it, vi } from 'vitest';

import type { WebSearchConfig } from '../../../src/config';
import { PluggableWebSearchProvider } from '../../../src/tools/providers/pluggable-web-search';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function firstUrl(fetchImpl: ReturnType<typeof routedFetch>): string {
  const arg = fetchImpl.mock.calls[0]?.[0];
  return typeof arg === 'string' ? arg : '';
}

const OPENAI_BODY = {
  output: [
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'answer',
          annotations: [
            { type: 'url_citation', url: 'https://o.example', title: 'O', start_index: 0, end_index: 6 },
          ],
        },
      ],
    },
  ],
};
const BRAVE_BODY = { web: { results: [{ title: 'B', url: 'https://b.example', description: 'bd' }] } };
const TAVILY_BODY = { results: [{ title: 'T', url: 'https://t.example', content: 'tc' }] };

// Routes a single fetch mock to the right canned body based on the URL.
function routedFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : '';
    if (url.includes('/responses')) return Promise.resolve(jsonResponse(OPENAI_BODY));
    if (url.includes('/web/search')) return Promise.resolve(jsonResponse(BRAVE_BODY));
    if (url.includes('/search')) return Promise.resolve(jsonResponse(TAVILY_BODY));
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('PluggableWebSearchProvider', () => {
  it('uses openai as the implicit default when present', async () => {
    const fetchImpl = routedFetch();
    const config: WebSearchConfig = {
      providers: {
        brave: { type: 'brave', apiKey: 'bk' },
        openai: { type: 'openai', apiKey: 'ok' },
      },
    };
    const provider = new PluggableWebSearchProvider(config, { fetchImpl, env: {} });

    const results = await provider.search('q');

    expect(firstUrl(fetchImpl)).toContain('/responses');
    expect(results[0]?.url).toBe('https://o.example');
  });

  it('honours the configured defaultProvider', async () => {
    const fetchImpl = routedFetch();
    const config: WebSearchConfig = {
      defaultProvider: 'tav',
      providers: {
        openai: { type: 'openai', apiKey: 'ok' },
        tav: { type: 'tavily', apiKey: 'tk' },
      },
    };
    const provider = new PluggableWebSearchProvider(config, { fetchImpl, env: {} });

    const results = await provider.search('q');

    expect(firstUrl(fetchImpl)).toContain('https://api.tavily.com/search');
    expect(results[0]?.url).toBe('https://t.example');
  });

  it('selects an explicit per-call provider', async () => {
    const fetchImpl = routedFetch();
    const config: WebSearchConfig = {
      providers: {
        openai: { type: 'openai', apiKey: 'ok' },
        brave: { type: 'brave', apiKey: 'bk' },
      },
    };
    const provider = new PluggableWebSearchProvider(config, { fetchImpl, env: {} });

    const results = await provider.search('q', { provider: 'brave' });

    expect(firstUrl(fetchImpl)).toContain('/web/search');
    expect(results[0]?.url).toBe('https://b.example');
  });

  it('throws when a selected provider has no usable api key', async () => {
    const fetchImpl = routedFetch();
    const config: WebSearchConfig = {
      providers: { brave: { type: 'brave' } },
    };
    const provider = new PluggableWebSearchProvider(config, { fetchImpl, env: {} });

    await expect(provider.search('q', { provider: 'brave' })).rejects.toThrow(/BRAVE_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a clear error for an unknown provider', async () => {
    const fetchImpl = routedFetch();
    const config: WebSearchConfig = {
      providers: { openai: { type: 'openai', apiKey: 'ok' } },
    };
    const provider = new PluggableWebSearchProvider(config, { fetchImpl, env: {} });

    await expect(provider.search('q', { provider: 'nope' })).rejects.toThrow(/Unknown search provider 'nope'/);
  });
});
