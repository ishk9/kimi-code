/**
 * BrowserTool — host-injected, stateful browser automation.
 *
 * kimi-core defines the `BrowserController` interface; the host provides the
 * real implementation (Playwright). If no controller is supplied, the tool is
 * not registered (not exposed to the LLM).
 *
 * The tool exposes a single `Browser` entry point with an `action` discriminator
 * so the model drives one persistent page across calls: navigate, read the
 * page, click, type, enumerate links, download files, and screenshot.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './browser.md?raw';

// ── Controller interface (host-injected) ─────────────────────────────

export interface BrowserLink {
  /** The visible (trimmed) link text. */
  readonly text: string;
  /** The fully-resolved absolute href. */
  readonly href: string;
}

export interface BrowserSnapshot {
  readonly url: string;
  readonly title: string;
  /** Visible page text, already truncated by the controller. */
  readonly text: string;
  /** A capped list of on-page links. */
  readonly links: readonly BrowserLink[];
}

export interface DownloadedFile {
  /** Absolute path to the saved file. */
  readonly path: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sourceUrl?: string | undefined;
  readonly contentType?: string | undefined;
}

export interface BrowserClickTarget {
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
}

export interface BrowserTypeInput {
  readonly selector: string;
  readonly value: string;
  readonly submit?: boolean | undefined;
}

export interface BrowserLinkFilter {
  readonly contains?: string | undefined;
  readonly extensions?: readonly string[] | undefined;
}

export interface BrowserDownloadTarget {
  readonly url?: string | undefined;
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
}

export interface BrowserDownloadOptions {
  readonly subdir?: string | undefined;
  readonly filename?: string | undefined;
}

export interface BrowserController {
  navigate(url: string): Promise<BrowserSnapshot>;
  snapshot(): Promise<BrowserSnapshot>;
  click(target: BrowserClickTarget): Promise<BrowserSnapshot>;
  type(input: BrowserTypeInput): Promise<BrowserSnapshot>;
  listLinks(filter?: BrowserLinkFilter): Promise<readonly BrowserLink[]>;
  download(target: BrowserDownloadTarget, options?: BrowserDownloadOptions): Promise<DownloadedFile>;
  screenshot(options?: { fullPage?: boolean }): Promise<string>;
  close(): Promise<void>;
}

// ── Input schema ─────────────────────────────────────────────────────

export const BrowserActions = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'links',
  'download',
  'screenshot',
  'close',
] as const;

export const BrowserInputSchema = z.object({
  action: z
    .enum(BrowserActions)
    .describe(
      'The browser action to perform: navigate | snapshot | click | type | links | download | screenshot | close.',
    ),
  url: z
    .string()
    .describe('For `navigate`: the page URL. For `download`: an optional direct file URL to fetch.')
    .optional(),
  selector: z
    .string()
    .describe('CSS selector. For `click`/`type`/`download` (the element to act on).')
    .optional(),
  text: z
    .string()
    .describe('For `click`/`download`: visible link or button text to match instead of a selector.')
    .optional(),
  value: z.string().describe('For `type`: the text to enter into the field.').optional(),
  submit: z.boolean().describe('For `type`: press Enter after typing.').optional(),
  contains: z
    .string()
    .describe('For `links`: only return links whose href or text contains this substring.')
    .optional(),
  extensions: z
    .array(z.string())
    .describe("For `links`/`download`: file extensions to match, e.g. ['csv', 'xlsx', 'xls'].")
    .optional(),
  subdir: z
    .string()
    .describe('For `download`: subdirectory (relative) under the downloads directory to save into.')
    .optional(),
  filename: z.string().describe('For `download`: explicit filename to save the file as.').optional(),
  full_page: z.boolean().describe('For `screenshot`: capture the full scrollable page.').optional(),
});

export type BrowserInput = z.Infer<typeof BrowserInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

const MAX_LINKS_RENDERED = 100;

export class BrowserTool implements BuiltinTool<BrowserInput> {
  readonly name = 'Browser' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BrowserInputSchema);
  constructor(private readonly controller: BrowserController) {}

  resolveExecution(args: BrowserInput): ToolExecution {
    const subject = this.describeSubject(args);
    return {
      accesses: ToolAccesses.none(),
      description: `Browser: ${subject}`,
      display: { kind: 'generic', summary: `Browser ${args.action}: ${subject}` },
      approvalRule: literalRulePattern(this.name, args.action),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.action),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private describeSubject(args: BrowserInput): string {
    switch (args.action) {
      case 'navigate':
        return args.url ?? '(no url)';
      case 'click':
        return args.text ?? args.selector ?? '(no target)';
      case 'type':
        return args.selector ?? '(no field)';
      case 'download':
        return args.url ?? args.text ?? args.selector ?? '(no target)';
      case 'snapshot':
      case 'links':
      case 'screenshot':
      case 'close':
        return args.action;
      default:
        return args.action;
    }
  }

  private async execution(
    args: BrowserInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      throwIfAborted(signal);
      const builder = new ToolResultBuilder({ maxLineLength: null });

      switch (args.action) {
        case 'navigate': {
          if (!args.url) return errorResult('`navigate` requires `url`.');
          renderSnapshot(builder, await this.controller.navigate(args.url));
          return builder.ok();
        }
        case 'snapshot': {
          renderSnapshot(builder, await this.controller.snapshot());
          return builder.ok();
        }
        case 'click': {
          if (!args.selector && !args.text) {
            return errorResult('`click` requires `selector` or `text`.');
          }
          const target: BrowserClickTarget = { selector: args.selector, text: args.text };
          renderSnapshot(builder, await this.controller.click(target));
          return builder.ok();
        }
        case 'type': {
          if (!args.selector) return errorResult('`type` requires `selector`.');
          if (args.value === undefined) return errorResult('`type` requires `value`.');
          renderSnapshot(
            builder,
            await this.controller.type({
              selector: args.selector,
              value: args.value,
              submit: args.submit,
            }),
          );
          return builder.ok();
        }
        case 'links': {
          const links = await this.controller.listLinks({
            contains: args.contains,
            extensions: args.extensions,
          });
          renderLinks(builder, links);
          return builder.ok();
        }
        case 'download': {
          if (!args.url && !args.selector && !args.text) {
            return errorResult('`download` requires `url`, `selector`, or `text`.');
          }
          const file = await this.controller.download(
            { url: args.url, selector: args.selector, text: args.text },
            { subdir: args.subdir, filename: args.filename },
          );
          builder.write(
            `Downloaded ${file.filename} (${formatBytes(file.bytes)}) to:\n${file.path}\n`,
          );
          if (file.sourceUrl) builder.write(`Source: ${file.sourceUrl}\n`);
          if (file.contentType) builder.write(`Content-Type: ${file.contentType}\n`);
          return builder.ok();
        }
        case 'screenshot': {
          const path = await this.controller.screenshot({ fullPage: args.full_page });
          builder.write(`Screenshot saved to:\n${path}\n`);
          return builder.ok();
        }
        case 'close': {
          await this.controller.close();
          builder.write('Browser closed.');
          return builder.ok();
        }
        default:
          return errorResult(`Unknown action '${String(args.action)}'.`);
      }
    } catch (error) {
      return { isError: true, output: classifyBrowserError(error) };
    }
  }
}

// ── Rendering helpers ────────────────────────────────────────────────

function renderSnapshot(builder: ToolResultBuilder, snapshot: BrowserSnapshot): void {
  builder.write(`Title: ${snapshot.title}\n`);
  builder.write(`URL: ${snapshot.url}\n\n`);
  if (snapshot.text.length > 0) {
    builder.write(`${snapshot.text}\n\n`);
  }
  renderLinks(builder, snapshot.links);
}

function renderLinks(builder: ToolResultBuilder, links: readonly BrowserLink[]): void {
  if (links.length === 0) {
    builder.write('Links: (none matched)\n');
    return;
  }
  const shown = links.slice(0, MAX_LINKS_RENDERED);
  builder.write(`Links (${shown.length}${links.length > shown.length ? ` of ${links.length}` : ''}):\n`);
  for (const link of shown) {
    const label = link.text.length > 0 ? link.text : '(no text)';
    builder.write(`  - ${label} → ${link.href}\n`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('Browser action cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function classifyBrowserError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) {
    return `Browser action cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('timed out')) {
    return `Browser action timed out: ${message}. The selector may not exist or the page is slow.`;
  }
  if (
    lower.includes("executable doesn't exist") ||
    lower.includes('please run the following command') ||
    lower.includes('browsertype.launch')
  ) {
    return `Browser engine is not installed. Run \`npx playwright install chromium\` and try again. ${message}`;
  }
  return `Browser action failed: ${message}`;
}
