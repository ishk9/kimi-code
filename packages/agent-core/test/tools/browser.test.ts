/**
 * Covers: BrowserTool (with a fake BrowserController) and the pure
 * link-parsing / path helpers of PlaywrightBrowserController.
 *
 * No real browser is launched here — the tool is exercised against an
 * in-memory controller, and the parsing helpers run on static HTML.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BrowserInputSchema,
  BrowserTool,
  type BrowserController,
  type BrowserSnapshot,
  type DownloadedFile,
} from '../../src/tools/builtin/web/browser';
import {
  deriveFilename,
  extractLinks,
  filterLinks,
  sanitizeSubdir,
} from '../../src/tools/providers/playwright-browser';
import { toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

const SNAPSHOT: BrowserSnapshot = {
  url: 'https://example.com/data',
  title: 'Data Portal',
  text: 'Welcome to the data portal.',
  links: [
    { text: '2021 rainfall', href: 'https://example.com/files/2021.csv' },
    { text: '2022 rainfall', href: 'https://example.com/files/2022.xlsx' },
  ],
};

function fakeController(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    navigate: vi.fn().mockResolvedValue(SNAPSHOT),
    snapshot: vi.fn().mockResolvedValue(SNAPSHOT),
    click: vi.fn().mockResolvedValue(SNAPSHOT),
    type: vi.fn().mockResolvedValue(SNAPSHOT),
    listLinks: vi.fn().mockResolvedValue(SNAPSHOT.links),
    download: vi.fn().mockResolvedValue({
      path: '/tmp/x/2021.csv',
      filename: '2021.csv',
      bytes: 2048,
      sourceUrl: 'https://example.com/files/2021.csv',
      contentType: 'text/csv',
    } satisfies DownloadedFile),
    screenshot: vi.fn().mockResolvedValue('/tmp/x/shot.png'),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('BrowserTool', () => {
  it('has name "Browser" and a non-empty description', () => {
    const tool = new BrowserTool(fakeController());
    expect(tool.name).toBe('Browser');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('exposes the action enum in its parameters', () => {
    const tool = new BrowserTool(fakeController());
    expect(BrowserInputSchema.safeParse({ action: 'navigate', url: 'https://x.com' }).success).toBe(
      true,
    );
    const action = (tool.parameters as { properties: Record<string, { enum?: string[] }> })
      .properties['action'];
    expect(action?.enum).toContain('navigate');
    expect(action?.enum).toContain('download');
  });

  it('navigate renders title, url, and links', async () => {
    const controller = fakeController();
    const tool = new BrowserTool(controller);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { action: 'navigate', url: 'https://example.com/data' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(controller.navigate).toHaveBeenCalledWith('https://example.com/data');
    const content = toolContentString(result);
    expect(content).toContain('Data Portal');
    expect(content).toContain('https://example.com/files/2021.csv');
  });

  it('navigate without url is an error', async () => {
    const tool = new BrowserTool(fakeController());
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c2',
      args: { action: 'navigate' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('requires `url`');
  });

  it('click requires a selector or text', async () => {
    const tool = new BrowserTool(fakeController());
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c3',
      args: { action: 'click' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('requires `selector` or `text`');
  });

  it('download reports the saved path and size', async () => {
    const controller = fakeController();
    const tool = new BrowserTool(controller);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c4',
      args: { action: 'download', url: 'https://example.com/files/2021.csv', subdir: 'fsdata/x' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(controller.download).toHaveBeenCalledWith(
      { url: 'https://example.com/files/2021.csv', selector: undefined, text: undefined },
      { subdir: 'fsdata/x', filename: undefined },
    );
    const content = toolContentString(result);
    expect(content).toContain('2021.csv');
    expect(content).toContain('/tmp/x/2021.csv');
    expect(content).toContain('2.0 KB');
  });

  it('links forwards the extension filter to the controller', async () => {
    const controller = fakeController();
    const tool = new BrowserTool(controller);
    await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c5',
      args: { action: 'links', extensions: ['csv', 'xlsx'], contains: 'rainfall' },
      signal,
    });
    expect(controller.listLinks).toHaveBeenCalledWith({
      contains: 'rainfall',
      extensions: ['csv', 'xlsx'],
    });
  });

  it('close tears the browser down', async () => {
    const controller = fakeController();
    const tool = new BrowserTool(controller);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c6',
      args: { action: 'close' },
      signal,
    });
    expect(result.isError).toBe(false);
    expect(controller.close).toHaveBeenCalledOnce();
    expect(toolContentString(result)).toContain('Browser closed');
  });

  it('surfaces a friendly hint when the engine is not installed', async () => {
    const controller = fakeController({
      navigate: vi.fn().mockRejectedValue(new Error("Executable doesn't exist at /path/chrome")),
    });
    const tool = new BrowserTool(controller);
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c7',
      args: { action: 'navigate', url: 'https://example.com' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('playwright install chromium');
  });
});

describe('PlaywrightBrowserController helpers', () => {
  const html = `
    <a href="/files/2021.csv">2021</a>
    <a href="data.xlsx">Excel</a>
    <a href="https://other.test/report.pdf">PDF</a>
    <a href="#section">anchor</a>
    <a href="javascript:void(0)">js</a>
    <a href="/files/2021.csv">dup</a>
  `;

  it('extracts and absolutizes links, skipping anchors and javascript', () => {
    const links = extractLinks(html, 'https://example.com/data/index.html');
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/files/2021.csv');
    expect(hrefs).toContain('https://example.com/data/data.xlsx');
    expect(hrefs).toContain('https://other.test/report.pdf');
    // anchors, javascript:, and duplicates are dropped
    expect(hrefs.filter((h) => h.includes('2021.csv'))).toHaveLength(1);
    expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
  });

  it('filters links by extension', () => {
    const links = extractLinks(html, 'https://example.com/data/index.html');
    const csvOnly = filterLinks(links, { extensions: ['csv', 'xlsx'] });
    expect(csvOnly.map((l) => l.href)).toEqual([
      'https://example.com/files/2021.csv',
      'https://example.com/data/data.xlsx',
    ]);
  });

  it('filters links by substring', () => {
    const links = extractLinks(html, 'https://example.com/data/index.html');
    const filtered = filterLinks(links, { contains: 'report' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.href).toBe('https://other.test/report.pdf');
  });

  it('sanitizes traversal out of download subdirs', () => {
    expect(sanitizeSubdir('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeSubdir('/abs/path')).toBe('abs/path');
    expect(sanitizeSubdir('fsdata/mildura')).toBe('fsdata/mildura');
  });

  it('derives filenames from URLs', () => {
    expect(deriveFilename('https://x.com/a/b/data.csv?y=1', 'fallback')).toBe('data.csv');
    expect(deriveFilename('not a url', 'fallback')).toBe('fallback');
  });
});
