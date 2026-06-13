import { describe, expect, it, vi } from 'vitest';

import { handleFsdataCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(
  overrides: { model?: string; hasSession?: boolean } = {},
): SlashCommandHost {
  const session = {};
  const hasSession = overrides.hasSession ?? true;
  return {
    state: {
      appState: { model: overrides.model ?? 'kimi-model' },
    },
    session: hasSession ? session : undefined,
    harness: { homeDir: '' },
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
}

function lastStatus(host: SlashCommandHost): string {
  const mock = host.showStatus as ReturnType<typeof vi.fn>;
  return (mock.mock.calls.at(-1)?.[0] as string) ?? '';
}

function lastError(host: SlashCommandHost): string {
  const mock = host.showError as ReturnType<typeof vi.fn>;
  return (mock.mock.calls.at(-1)?.[0] as string) ?? '';
}

function lastInput(host: SlashCommandHost): string {
  const mock = host.sendNormalUserInput as ReturnType<typeof vi.fn>;
  return (mock.mock.calls.at(-1)?.[0] as string) ?? '';
}

describe('handleFsdataCommand', () => {
  it('prints usage when nothing is given', () => {
    const host = makeHost();
    handleFsdataCommand(host, '');
    expect(lastStatus(host)).toContain('/fsdata <region> <place>');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('blocks when no model/session is configured', () => {
    const host = makeHost({ model: '' });
    handleFsdataCommand(host, 'nsw Badgerys Creek 2020');
    expect(host.showError).toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('hardcodes the BoM site and resolves region, station slug, and a year range', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'nsw Badgerys Creek 2020-2023');
    expect(host.track).toHaveBeenCalledWith('fsdata_invoked', {
      has_state: true,
      has_place: true,
      year_count: 4,
    });
    const prompt = lastInput(host);
    // hardcoded BoM entry point + state daily table for the resolved region
    expect(prompt).toContain('https://www.bom.gov.au/watl/eto/maps/aus.shtml');
    expect(prompt).toContain('https://www.bom.gov.au/watl/eto/tables/nsw/daily.shtml');
    // resolved station slug + region label
    expect(prompt).toContain('New South Wales (nsw)');
    expect(prompt).toContain('badgerys_creek');
    expect(prompt).toContain('Browser');
    // the expanded range 2020,2021,2022,2023
    expect(prompt).toContain('2020, 2021, 2022, 2023');
  });

  it('accepts full state names and a discrete year list', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'Victoria Mildura 2021 2022');
    const prompt = lastInput(host);
    expect(prompt).toContain('https://www.bom.gov.au/watl/eto/tables/vic/daily.shtml');
    expect(prompt).toContain('Victoria (vic)');
    expect(prompt).toContain('mildura');
    expect(prompt).toContain('2021, 2022');
  });

  it('asks for years when none are supplied', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'qld Cairns Airport');
    expect(host.track).toHaveBeenCalledWith('fsdata_invoked', {
      has_state: true,
      has_place: true,
      year_count: 0,
    });
    const prompt = lastInput(host);
    expect(prompt).toContain('cairns_airport');
    expect(prompt).toContain('STOP and ask');
  });

  it('falls back to the map when no region is recognised', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'Mildura 2021');
    const prompt = lastInput(host);
    // no region resolved -> start at the map, slug uses placeholder state
    expect(prompt).toContain('https://www.bom.gov.au/watl/eto/maps/aus.shtml');
    expect(prompt).toContain('state="<state>"');
    expect(prompt).toContain('mildura');
  });
});
