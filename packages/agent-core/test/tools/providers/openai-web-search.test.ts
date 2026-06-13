import { describe, expect, it, vi } from 'vitest';

import { OpenAIWebSearchProvider } from '../../../src/tools/providers/openai-web-search';

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
  output: [
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Cats are great. Dogs too.',
          annotations: [
            { type: 'url_citation', url: 'https://a.example', title: 'A', start_index: 0, end_index: 14 },
            { type: 'url_citation', url: 'https://b.example', title: 'B', start_index: 16, end_index: 25 },
          ],
        },
      ],
    },
  ],
};

describe('OpenAIWebSearchProvider', () => {
  it('maps url_citation annotations to WebSearchResult[] and attaches the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new OpenAIWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    const results = await provider.search('cats vs dogs');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'A', url: 'https://a.example', snippet: 'Cats are great' });
    expect(results[1]).toMatchObject({ title: 'B', url: 'https://b.example' });
    // The synthesised answer is surfaced once, on the first result.
    expect(results[0]?.content).toContain('Cats are great. Dogs too.');
  });

  it('targets the Responses API with the default model and bearer auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new OpenAIWebSearchProvider({ apiKey: 'secret-key', fetchImpl, env: {} });

    await provider.search('hello');

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('https://api.openai.com/v1/responses');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key');
    const body = bodyJson(init?.body);
    expect(body['model']).toBe('gpt-5-mini');
    expect(body['input']).toBe('hello');
    expect(body['tools']).toEqual([{ type: 'web_search' }]);
  });

  it('honours a configured model and baseUrl override', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new OpenAIWebSearchProvider({
      apiKey: 'k',
      model: 'gpt-5',
      baseUrl: 'https://proxy.example/v2/',
      fetchImpl,
      env: {},
    });

    await provider.search('hello');

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('https://proxy.example/v2/responses');
    const body = bodyJson(init?.body);
    expect(body['model']).toBe('gpt-5');
  });

  it('falls back to OPENAI_API_KEY when the configured apiKey is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new OpenAIWebSearchProvider({
      fetchImpl,
      env: { OPENAI_API_KEY: 'env-key' },
    });

    await provider.search('hello');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer env-key');
  });

  it('throws a clear error when no api key is available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SAMPLE));
    const provider = new OpenAIWebSearchProvider({ fetchImpl, env: {} });

    await expect(provider.search('hello')).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a single summary result when there are no citations', async () => {
    const noCitations = {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Just prose.' }] }],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(noCitations));
    const provider = new OpenAIWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    const results = await provider.search('hello');

    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBe('Just prose.');
  });

  it('throws on a 401 response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 401 }));
    const provider = new OpenAIWebSearchProvider({ apiKey: 'k', fetchImpl, env: {} });

    await expect(provider.search('hello')).rejects.toThrow(/HTTP 401/);
  });
});
