import type { BrowserController, UrlFetcher, WebSearchProvider } from '../builtin';

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  readonly browser?: BrowserController;
}
