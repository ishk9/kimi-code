import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

const FSDATA_USAGE = `Usage:
  /fsdata <url> <region / place / years / what to do>

Opens a real browser at <url>, navigates to the place you name, finds the CSV/Excel
data files, downloads them locally, and reports a manifest. If you don't say which
years, it will ask before downloading.

Example:
  /fsdata https://www.bom.gov.au/watl/eto/maps/aus.shtml Victoria, Mildura — evapotranspiration CSV for 2020-2023`;

/** Split a string into its first whitespace-delimited token and the trimmed remainder. */
function partition(input: string): readonly [string, string] {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  if (match === null) return ['', ''];
  return [match[1] ?? '', (match[2] ?? '').trim()];
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasModelAndSession(host: SlashCommandHost): boolean {
  return host.state.appState.model.trim().length > 0 && host.session !== undefined;
}

function buildPrompt(url: string, request: string): string {
  return [
    'You are completing a field-station / gridded **data-gathering** task using the `Browser` tool (a real Chromium browser). Work step by step and re-read the page after each navigation.',
    '',
    `Target site: ${url}`,
    `Request: ${request.length > 0 ? request : '(the user did not add details — ask them which region/place and which years before doing anything)'}`,
    '',
    'Procedure:',
    '1. `navigate` to the target site, then read the title, text, and links.',
    '2. Locate the requested region/place. This may require clicking a map area, opening a region menu, or using a search box — use `click` and `type`, and call `snapshot` after each step to see where you landed.',
    '3. Find the downloadable data files (CSV and/or Excel). Use the `links` action with `extensions: ["csv","xlsx","xls"]`, and add `contains` with the place name when it helps narrow results.',
    '4. YEARS — if the request does not clearly state which year(s) or period to download, STOP and ask the user which years before downloading anything. If years are given, download only those.',
    '5. Download each matching file with the `download` action into subdir `fsdata/<short-place-slug>` (prefer downloading by the direct `url` from the links list).',
    '6. When done, report a manifest: for each file list filename, saved path, size, and — if discernible — the year/period and the columns or sheets it contains. Do NOT parse, merge, or transform the data yet; wait for the user\'s next instruction.',
    '',
    'If the site has no such files for the requested place, say so plainly and point to where the data actually lives (a different page or portal). Call the `Browser` `close` action when finished.',
  ].join('\n');
}

export function handleFsdataCommand(host: SlashCommandHost, args: string): void {
  const [url, request] = partition(args);

  if (url.length === 0) {
    host.showStatus(FSDATA_USAGE);
    return;
  }
  if (!looksLikeUrl(url)) {
    host.showError(`'${url}' is not a valid http(s) URL.\n${FSDATA_USAGE}`);
    return;
  }
  if (!hasModelAndSession(host)) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.track('fsdata_invoked', { has_request: request.length > 0 });
  host.sendNormalUserInput(buildPrompt(url, request));
}
