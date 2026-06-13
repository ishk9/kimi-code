/**
 * PlaywrightBrowserController — host-side browser automation.
 *
 * Implements `BrowserController` (defined in kimi-core) with Playwright's
 * Chromium engine. The browser is launched lazily on first use so sessions
 * that never touch the browser pay nothing, and `playwright` itself is loaded
 * via a dynamic import to keep it off the startup path.
 *
 * All page inspection avoids DOM globals (this package compiles without
 * `lib.dom`): visible text comes from `page.innerText`, and links are parsed
 * from `page.content()` with linkedom, resolving relative hrefs against the
 * current URL.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { parseHTML as rawParseHTML } from 'linkedom';
import type { Browser, BrowserContext, Page } from 'playwright';

import type {
  BrowserClickTarget,
  BrowserController,
  BrowserDownloadOptions,
  BrowserDownloadTarget,
  BrowserLink,
  BrowserLinkFilter,
  BrowserSnapshot,
  BrowserTypeInput,
  DownloadedFile,
} from '../builtin';

// linkedom's published types depend on DOM libs we don't load. Declare the
// minimal surface we use so the rest of the file stays type-safe.
interface DomAnchorLike {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}
interface DomDocumentLike {
  querySelectorAll(selector: string): Iterable<DomAnchorLike>;
}
const parseHTML = rawParseHTML as unknown as (html: string) => { document: DomDocumentLike };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_LINKS = 400;

export interface PlaywrightBrowserOptions {
  /** Run without a visible window. Defaults to `false` (headed). */
  readonly headless?: boolean | undefined;
  /** Use an installed browser channel instead of the bundled Chromium (e.g. 'chrome'). */
  readonly channel?: string | undefined;
  /** Default per-action timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** Absolute directory downloads and screenshots are written under. */
  readonly downloadDir: string;
}

export class PlaywrightBrowserController implements BrowserController {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightBrowserOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async navigate(url: string): Promise<BrowserSnapshot> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    return this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const [title, html] = await Promise.all([page.title(), page.content()]);
    let text = '';
    try {
      text = await page.innerText('body', { timeout: 2_000 });
    } catch {
      text = '';
    }
    return {
      url: page.url(),
      title,
      text: truncate(collapseWhitespace(text), MAX_TEXT_CHARS),
      links: extractLinks(html, page.url()),
    };
  }

  async click(target: BrowserClickTarget): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const locator = this.resolveLocator(target);
    await locator.first().click({ timeout: this.timeoutMs });
    await this.settle(page);
    return this.snapshot();
  }

  async type(input: BrowserTypeInput): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    await page.fill(input.selector, input.value, { timeout: this.timeoutMs });
    if (input.submit === true) {
      await page.press(input.selector, 'Enter', { timeout: this.timeoutMs });
      await this.settle(page);
    }
    return this.snapshot();
  }

  async listLinks(filter?: BrowserLinkFilter): Promise<readonly BrowserLink[]> {
    const page = this.requirePage();
    const html = await page.content();
    return filterLinks(extractLinks(html, page.url()), filter);
  }

  async download(
    target: BrowserDownloadTarget,
    options?: BrowserDownloadOptions,
  ): Promise<DownloadedFile> {
    const page = await this.ensurePage();
    const dir = await this.resolveDownloadDir(options?.subdir);

    // Direct URL: fetch through the browser context so cookies/session apply.
    if (target.url !== undefined && target.url.length > 0) {
      const context = this.requireContext();
      const response = await context.request.get(target.url, { timeout: this.timeoutMs });
      if (!response.ok()) {
        throw new Error(`Download failed with HTTP ${String(response.status())} for ${target.url}`);
      }
      const body = await response.body();
      const filename = options?.filename ?? deriveFilename(target.url, 'download');
      const path = join(dir, filename);
      await writeFile(path, body);
      return {
        path,
        filename,
        bytes: body.byteLength,
        sourceUrl: target.url,
        contentType: response.headers()['content-type'],
      };
    }

    // Click-triggered download: race the click against the download event.
    const locator = this.resolveLocator({ selector: target.selector, text: target.text });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: this.timeoutMs }),
      locator.first().click({ timeout: this.timeoutMs }),
    ]);
    const filename = options?.filename ?? download.suggestedFilename();
    const path = join(dir, filename);
    await download.saveAs(path);
    const bytes = await fileSize(path);
    return { path, filename, bytes, sourceUrl: download.url() };
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<string> {
    const page = this.requirePage();
    const dir = await this.resolveDownloadDir('screenshots');
    const path = join(dir, `screenshot-${String(Date.now())}.png`);
    await page.screenshot({ path, fullPage: options?.fullPage ?? false });
    return path;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────

  private async ensurePage(): Promise<Page> {
    if (this.page !== undefined) return this.page;
    const { chromium } = await import('playwright');
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: this.options.headless ?? false,
    };
    if (this.options.channel !== undefined) launchOptions.channel = this.options.channel;
    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({ acceptDownloads: true });
    this.context.setDefaultTimeout(this.timeoutMs);
    this.page = await this.context.newPage();
    return this.page;
  }

  private requirePage(): Page {
    if (this.page === undefined) {
      throw new Error('No page open. Call the Browser `navigate` action first.');
    }
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (this.context === undefined) {
      throw new Error('No browser context. Call the Browser `navigate` action first.');
    }
    return this.context;
  }

  private resolveLocator(target: BrowserClickTarget): ReturnType<Page['locator']> {
    const page = this.requirePage();
    if (target.selector !== undefined && target.selector.length > 0) {
      return page.locator(target.selector);
    }
    if (target.text !== undefined && target.text.length > 0) {
      return page.getByText(target.text, { exact: false });
    }
    throw new Error('A `selector` or `text` is required to locate the element.');
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs }).catch(() => undefined);
  }

  private async resolveDownloadDir(subdir?: string): Promise<string> {
    const base = this.options.downloadDir;
    const dir =
      subdir !== undefined && subdir.length > 0 ? resolve(base, sanitizeSubdir(subdir)) : base;
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

// ── helpers ──────────────────────────────────────────────────────────

export function extractLinks(html: string, baseUrl: string): readonly BrowserLink[] {
  const { document } = parseHTML(html);
  const links: BrowserLink[] = [];
  const seen = new Set<string>();
  for (const anchor of document.querySelectorAll('a')) {
    if (links.length >= MAX_LINKS) break;
    const rawHref = anchor.getAttribute('href');
    if (rawHref === null || rawHref.length === 0) continue;
    if (rawHref.startsWith('javascript:') || rawHref.startsWith('#')) continue;
    const href = absolutize(rawHref, baseUrl);
    if (href === undefined || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: collapseWhitespace(anchor.textContent ?? ''), href });
  }
  return links;
}

export function filterLinks(
  links: readonly BrowserLink[],
  filter?: BrowserLinkFilter,
): readonly BrowserLink[] {
  if (filter === undefined) return links;
  const contains = filter.contains?.toLowerCase();
  const exts = filter.extensions?.map((ext) => ext.replace(/^\./, '').toLowerCase());
  return links.filter((link) => {
    if (contains !== undefined && contains.length > 0) {
      const haystack = `${link.href} ${link.text}`.toLowerCase();
      if (!haystack.includes(contains)) return false;
    }
    if (exts !== undefined && exts.length > 0) {
      const path = stripQuery(link.href).toLowerCase();
      if (!exts.some((ext) => path.endsWith(`.${ext}`))) return false;
    }
    return true;
  });
}

function absolutize(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const end = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(0, end);
}

export function deriveFilename(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = basename(pathname);
    return name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

export function sanitizeSubdir(subdir: string): string {
  const normalized = subdir.replaceAll('\\', '/');
  const safe = normalized
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .join('/');
  return isAbsolute(safe) ? safe.replace(/^\/+/, '') : safe;
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/[ \t]+/g, ' ').replaceAll(/\n{3,}/g, '\n\n').trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${String(text.length - max)} more chars)`;
}

async function fileSize(path: string): Promise<number> {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
