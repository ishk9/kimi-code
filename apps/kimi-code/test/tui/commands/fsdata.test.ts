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
  it('prints usage when no url is given', () => {
    const host = makeHost();
    handleFsdataCommand(host, '');
    expect(lastStatus(host)).toContain('/fsdata <url>');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('rejects a non-url first argument', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'not-a-url some place');
    expect(lastError(host)).toContain('not a valid http(s) URL');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('blocks when no model/session is configured', () => {
    const host = makeHost({ model: '' });
    handleFsdataCommand(host, 'https://example.com region X');
    expect(host.showError).toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('sends a browser-driving prompt for a valid url + request', () => {
    const host = makeHost();
    handleFsdataCommand(
      host,
      'https://www.bom.gov.au/watl/eto/maps/aus.shtml Victoria, Mildura — CSV for 2020-2023',
    );
    expect(host.track).toHaveBeenCalledWith('fsdata_invoked', { has_request: true });
    const prompt = lastInput(host);
    expect(prompt).toContain('https://www.bom.gov.au/watl/eto/maps/aus.shtml');
    expect(prompt).toContain('Victoria, Mildura');
    expect(prompt).toContain('Browser');
    expect(prompt).toContain('extensions: ["csv","xlsx","xls"]');
    // honours the "ask about years if unspecified" requirement
    expect(prompt).toContain('STOP and ask');
  });

  it('still works (and flags no request) when only a url is given', () => {
    const host = makeHost();
    handleFsdataCommand(host, 'https://example.com/data');
    expect(host.track).toHaveBeenCalledWith('fsdata_invoked', { has_request: false });
    expect(lastInput(host)).toContain('https://example.com/data');
  });
});
