/**
 * OpenAIWebSearchProvider — host-side `WebSearchProvider`.
 *
 * Mirrors the Python `_search_openai` implementation: it calls OpenAI's
 * hosted `web_search` tool through the Responses API (`POST {baseUrl}/responses`)
 * and adapts the streamed answer + `url_citation` annotations into the
 * `WebSearchResult[]` contract used by the WebSearch tool.
 *
 * The Responses API returns a synthesised answer rather than a flat result
 * list, so the mapping is:
 *   - each unique `url_citation` becomes a result whose `snippet` is the cited
 *     text span (the slice the model attributed to that source);
 *   - the full synthesised answer is attached as `content` on the first result
 *     so the model still sees the prose summary OpenAI produced.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_SEARCH_MODEL = 'gpt-5-mini';
const ENV_API_KEY = 'OPENAI_API_KEY';

export interface OpenAIWebSearchProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface OpenAIUrlCitation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface OpenAIContentPart {
  type?: string;
  text?: string;
  annotations?: OpenAIUrlCitation[];
}

interface OpenAIOutputItem {
  type?: string;
  content?: OpenAIContentPart[];
}

interface OpenAIResponsesBody {
  output?: OpenAIOutputItem[];
}

export class OpenAIWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;

  constructor(options: OpenAIWebSearchProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.model = nonEmpty(options.model) ?? DEFAULT_SEARCH_MODEL;
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

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: query,
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
      }),
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(`OpenAI search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim());
    }
    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(`OpenAI search request failed: HTTP ${String(response.status)}. ${detail}`.trim());
    }

    const json = (await response.json()) as OpenAIResponsesBody;
    return mapResponse(json, limit);
  }

  private resolveApiKey(): string {
    const key = nonEmpty(this.apiKey) ?? nonEmpty(this.env[ENV_API_KEY]);
    if (key === undefined) {
      throw new Error(
        `OpenAI search is not configured: set the provider apiKey or the ${ENV_API_KEY} environment variable.`,
      );
    }
    return key;
  }
}

function mapResponse(json: OpenAIResponsesBody, limit: number): WebSearchResult[] {
  const output = Array.isArray(json.output) ? json.output : [];
  const answerParts: string[] = [];
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of output) {
    if (item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type !== 'output_text') continue;
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.length > 0) answerParts.push(text);

      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (annotation.type !== 'url_citation') continue;
        const url = typeof annotation.url === 'string' ? annotation.url : '';
        if (url.length === 0 || seenUrls.has(url)) continue;
        seenUrls.add(url);

        const title = typeof annotation.title === 'string' ? annotation.title : '';
        const result: WebSearchResult = {
          title: title.length > 0 ? title : url,
          url,
          snippet: citationSnippet(text, annotation),
        };
        results.push(result);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  const answer = answerParts.join('\n\n').trim();

  if (results.length === 0) {
    if (answer.length === 0) return [];
    return [{ title: 'Web search summary', url: '', snippet: answer }];
  }

  // Surface the synthesised answer once, on the first result, so the model
  // sees OpenAI's prose summary in addition to the per-source snippets.
  if (answer.length > 0) {
    const first = results[0];
    if (first !== undefined) first.content = answer;
  }
  return results;
}

function citationSnippet(text: string, annotation: OpenAIUrlCitation): string {
  const start = annotation.start_index;
  const end = annotation.end_index;
  if (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length
  ) {
    const slice = text.slice(start, end).trim();
    if (slice.length > 0) return slice;
  }
  return text.trim();
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
