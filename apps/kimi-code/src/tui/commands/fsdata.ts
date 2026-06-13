import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

const BOM_BASE = 'https://www.bom.gov.au';
const BOM_MAP_PAGE = `${BOM_BASE}/watl/eto/maps/aus.shtml`;

const FSDATA_USAGE = `Usage:
  /fsdata <region> <place> [years]

Hardcoded for the Bureau of Meteorology evapotranspiration archive
(${BOM_MAP_PAGE}). Opens a real browser, finds the weather station
you name, and downloads its monthly evapotranspiration CSV files locally.

Region is one of: NSW, VIC, QLD, WA, SA, TAS, NT (full names also work).
Years can be a list or a range; if you omit them it will ask first.

Examples:
  /fsdata nsw Badgerys Creek 2020-2023
  /fsdata Victoria Mildura 2021 2022
  /fsdata qld Cairns Airport`;

type StateKey = 'nsw' | 'vic' | 'qld' | 'wa' | 'sa' | 'tas' | 'nt';

interface StateMatch {
  readonly key: StateKey;
  readonly label: string;
}

/** Aliases are matched longest-first so multi-word names win over abbreviations. */
const STATE_ALIASES: ReadonlyArray<readonly [string, StateKey, string]> = [
  ['new south wales', 'nsw', 'New South Wales'],
  ['western australia', 'wa', 'Western Australia'],
  ['south australia', 'sa', 'South Australia'],
  ['northern territory', 'nt', 'Northern Territory'],
  ['queensland', 'qld', 'Queensland'],
  ['tasmania', 'tas', 'Tasmania'],
  ['victoria', 'vic', 'Victoria'],
  ['nsw', 'nsw', 'New South Wales'],
  ['qld', 'qld', 'Queensland'],
  ['vic', 'vic', 'Victoria'],
  ['tas', 'tas', 'Tasmania'],
  ['wa', 'wa', 'Western Australia'],
  ['sa', 'sa', 'South Australia'],
  ['nt', 'nt', 'Northern Territory'],
];

interface ParsedRequest {
  readonly state?: StateMatch;
  readonly place: string;
  readonly years: readonly number[];
}

/** Strip a leading state alias from the (lowercased) input, if present. */
function matchLeadingState(input: string): { state?: StateMatch; rest: string } {
  const lower = input.toLowerCase();
  for (const [alias, key, label] of STATE_ALIASES) {
    if (lower === alias || lower.startsWith(`${alias} `)) {
      return { state: { key, label }, rest: input.slice(alias.length).trim() };
    }
  }
  return { rest: input };
}

/** Pull year tokens (single years and `YYYY-YYYY` ranges) out of the text. */
function extractYears(input: string): { years: number[]; rest: string } {
  const years = new Set<number>();
  const leftover: string[] = [];
  for (const token of input.split(/\s+/).filter((part) => part.length > 0)) {
    const range = token.match(/^((?:19|20)\d{2})-((?:19|20)\d{2})$/);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let year = Math.min(start, end); year <= Math.max(start, end); year += 1) years.add(year);
      continue;
    }
    if (/^(?:19|20)\d{2}$/.test(token)) {
      years.add(Number(token));
      continue;
    }
    leftover.push(token);
  }
  return { years: [...years].sort((a, b) => a - b), rest: leftover.join(' ') };
}

function parseRequest(args: string): ParsedRequest {
  const { state, rest } = matchLeadingState(args.trim());
  const { years, rest: place } = extractYears(rest);
  return { state, place: place.trim(), years };
}

/** Mirror BOM's station slug convention: lowercase, spaces → underscores, parens kept. */
function stationSlugHint(place: string): string {
  return place.trim().toLowerCase().replaceAll(/\s+/g, '_');
}

function hasModelAndSession(host: SlashCommandHost): boolean {
  return host.state.appState.model.trim().length > 0 && host.session !== undefined;
}

function buildPrompt(parsed: ParsedRequest): string {
  const { state, place, years } = parsed;
  const stateSeg = state?.key ?? '<state>';
  const slug = place.length > 0 ? stationSlugHint(place) : '<station_slug>';
  const startPage =
    state !== undefined
      ? `${BOM_BASE}/watl/eto/tables/${state.key}/daily.shtml`
      : BOM_MAP_PAGE;

  const yearsLine =
    years.length > 0
      ? years.join(', ')
      : '(not specified — STOP and ask the user which years before downloading anything)';

  return [
    'You are downloading **Bureau of Meteorology daily evapotranspiration** data with the `Browser` tool (a real Chromium browser). The whole site layout is fixed and documented below — follow it exactly, and call `snapshot` after each navigation to confirm where you landed.',
    '',
    `Region: ${state !== undefined ? `${state.label} (${state.key})` : '(not given — start at the map and pick the state)'}`,
    `Place / weather station: ${place.length > 0 ? place : '(not given — ask the user which station)'}`,
    `Years: ${yearsLine}`,
    '',
    'Known site structure (hardcoded — do not guess other URLs):',
    `- Map / state index: ${BOM_MAP_PAGE}`,
    `- State daily table:  ${BOM_BASE}/watl/eto/tables/<state>/daily.shtml   (state = nsw | vic | qld | wa | sa | tas | nt)`,
    `- Station page:       ${BOM_BASE}/watl/eto/tables/<state>/<station_slug>/<station_slug>.shtml`,
    `- Monthly CSV file:   ${BOM_BASE}/watl/eto/tables/<state>/<station_slug>/<station_slug>-YYYYMM.csv`,
    '  (<station_slug> = the place name lowercased with spaces turned into underscores, e.g. "Badgerys Creek" -> "badgerys_creek", "Byron Bay (Cape Byron)" -> "byron_bay_(cape_byron)")',
    '',
    'Procedure:',
    `1. \`navigate\` to ${startPage}. If you started at the map (no region was given), find the requested state in the list (NSW, Vic, Qld, WA, SA, Tas, NT) and open its daily table at ${BOM_BASE}/watl/eto/tables/<state>/daily.shtml.`,
    '2. On the state daily table, find the station whose name matches the requested place. Use the `links` action with `contains` set to the place name to list candidate station links, then pick the closest match (e.g. "Badgerys Creek", "Cairns Airport"). Read its href to learn the exact `<station_slug>`. If several plausible stations match, ask the user which one.',
    `   Best-guess station for this request: state="${stateSeg}", station_slug="${slug}" — verify it against the actual link before trusting it.`,
    '3. `navigate` to that station page. It shows current-month daily calculations plus a "Monthly Archive" table whose cells link to per-month CSV files.',
    '4. YEARS — if the years above are "(not specified)", STOP and ask the user which year(s) to download before fetching anything. Otherwise download only the requested years.',
    '5. For each requested year, collect that year\'s monthly CSV links. Use the `links` action with `extensions: ["csv"]` and `contains` set to the year (e.g. "2021") to get the direct URLs (one file per month, named <station_slug>-YYYYMM.csv). If a month is missing, skip it and note it.',
    `6. \`download\` each CSV by its direct \`url\` into subdir \`fsdata/bom-eto/${stateSeg}/${slug}\`. Keep the original filename.`,
    '7. When done, report a manifest: for each downloaded file list filename, saved path, size, and the year/month it covers. Note any months that were unavailable. Do NOT parse, merge, or transform the CSVs yet — wait for the next instruction.',
    '8. Call the `Browser` `close` action when finished.',
    '',
    'If the place cannot be found under the given state, say so plainly and list the closest station names you did find.',
  ].join('\n');
}

export function handleFsdataCommand(host: SlashCommandHost, args: string): void {
  const parsed = parseRequest(args);

  if (parsed.place.length === 0 && parsed.state === undefined) {
    host.showStatus(FSDATA_USAGE);
    return;
  }
  if (!hasModelAndSession(host)) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.track('fsdata_invoked', {
    has_state: parsed.state !== undefined,
    has_place: parsed.place.length > 0,
    year_count: parsed.years.length,
  });
  host.sendNormalUserInput(buildPrompt(parsed));
}
