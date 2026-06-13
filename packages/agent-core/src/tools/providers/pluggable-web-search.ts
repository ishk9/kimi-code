/**
 * PluggableWebSearchProvider — multiplexes across configured web-search
 * providers (openai / brave / tavily / moonshot).
 *
 * It is constructed from the resolved `WebSearchConfig` and lazily builds the
 * concrete `WebSearchProvider` for each configured name on first use. The
 * `search()` call selects a provider by the per-call `provider` option when it
 * names a configured provider, otherwise it falls back to the resolved default
 * provider. Selecting an unknown provider, or one whose API key is missing from
 * both config and the environment, surfaces a clear error to the tool.
 *
 * Default resolution mirrors the Python implementation: the configured
 * `defaultProvider` when it exists, else `openai` when present, else the first
 * configured provider.
 */

import type { WebSearchConfig, WebSearchProviderConfig } from '../../config';
import type { WebSearchProvider, WebSearchResult } from '../builtin';

import { BraveWebSearchProvider } from './brave-web-search';
import { MoonshotWebSearchProvider } from './moonshot-web-search';
import { OpenAIWebSearchProvider } from './openai-web-search';
import { TavilyWebSearchProvider } from './tavily-web-search';

export interface PluggableWebSearchProviderOptions {
  /** A pre-built Moonshot provider reused for `type: 'moonshot'` entries. */
  moonshot?: WebSearchProvider | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export class PluggableWebSearchProvider implements WebSearchProvider {
  private readonly providers: Record<string, WebSearchProviderConfig>;
  private readonly defaultProvider: string;
  private readonly options: PluggableWebSearchProviderOptions;
  private readonly cache = new Map<string, WebSearchProvider>();

  constructor(config: WebSearchConfig, options: PluggableWebSearchProviderOptions = {}) {
    this.providers = config.providers;
    this.options = options;
    this.defaultProvider = resolveDefaultProvider(config);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; provider?: string },
  ): Promise<WebSearchResult[]> {
    const requested = nonEmpty(options?.provider);
    const name = requested ?? this.defaultProvider;

    const conf = this.providers[name];
    if (conf === undefined) {
      const available = Object.keys(this.providers).toSorted().join(', ');
      throw new Error(
        `Unknown search provider '${name}'.${available.length > 0 ? ` Available providers: ${available}.` : ''}`,
      );
    }

    const provider = this.build(name, conf);
    return provider.search(query, options);
  }

  private build(name: string, conf: WebSearchProviderConfig): WebSearchProvider {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const provider = this.create(conf);
    this.cache.set(name, provider);
    return provider;
  }

  private create(conf: WebSearchProviderConfig): WebSearchProvider {
    const shared = {
      ...(conf.apiKey !== undefined ? { apiKey: conf.apiKey } : {}),
      ...(conf.baseUrl !== undefined ? { baseUrl: conf.baseUrl } : {}),
      ...(this.options.defaultHeaders !== undefined
        ? { defaultHeaders: this.options.defaultHeaders }
        : {}),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    };

    switch (conf.type) {
      case 'openai':
        return new OpenAIWebSearchProvider({
          ...shared,
          ...(conf.model !== undefined ? { model: conf.model } : {}),
        });
      case 'brave':
        return new BraveWebSearchProvider(shared);
      case 'tavily':
        return new TavilyWebSearchProvider(shared);
      case 'moonshot':
        return this.createMoonshot(conf);
    }
  }

  private createMoonshot(conf: WebSearchProviderConfig): WebSearchProvider {
    // A `type: 'moonshot'` entry reuses the injected Moonshot provider unless it
    // declares its own `baseUrl`, in which case we build a dedicated instance.
    if (conf.baseUrl === undefined) {
      if (this.options.moonshot !== undefined) return this.options.moonshot;
      throw new Error(
        "Moonshot search provider is not configured: set 'baseUrl' or provide a Moonshot service.",
      );
    }
    return new MoonshotWebSearchProvider({
      baseUrl: conf.baseUrl,
      ...(conf.apiKey !== undefined ? { apiKey: conf.apiKey } : {}),
      ...(this.options.defaultHeaders !== undefined
        ? { defaultHeaders: this.options.defaultHeaders }
        : {}),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }
}

function resolveDefaultProvider(config: WebSearchConfig): string {
  const names = Object.keys(config.providers);
  const configured = nonEmpty(config.defaultProvider);
  if (configured !== undefined && configured in config.providers) return configured;
  if ('openai' in config.providers) return 'openai';
  return names[0] ?? 'openai';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
