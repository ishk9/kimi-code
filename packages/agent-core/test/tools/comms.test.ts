/**
 * Covers: inter-agent messaging (MessageBus + SendMessage/CheckMessages/ListAgents).
 *
 *   - MessageBus: register, send A->B, B reads once then not again after markRead
 *   - MessageBus: concurrent interleaved sends do not corrupt the file
 *   - MessageBus: sending to an unknown handle throws UnknownRecipientError
 *   - Tools: SendMessage delivers, CheckMessages retrieves, ListAgents lists
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CheckMessagesTool,
  type CommsAgentRef,
  deriveCommsHandle,
  ListAgentsTool,
  MessageBus,
  resolveCommsBusPath,
  SendMessageTool,
  UnknownRecipientError,
} from '../../src/tools/builtin/collaboration/comms';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

let root: string;
let busPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kimi-comms-'));
  busPath = resolveCommsBusPath(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ref(handle: string, role = handle): CommsAgentRef {
  return { handle, role, busPath };
}

describe('MessageBus', () => {
  it('delivers a message once and not again after it is marked read', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('A', 'main');
    await bus.register('B', 'coder');

    const sent = await bus.send('A', 'B', 'hello B');
    expect(sent.id).toBe(1);

    const first = await bus.checkMessages('B');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ from: 'A', to: 'B', content: 'hello B', read: false });

    const second = await bus.checkMessages('B');
    expect(second).toHaveLength(0);
  });

  it('does not mark messages read when markRead is false', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('B');
    await bus.send('A', 'B', 'sticky', 'main');

    expect(await bus.checkMessages('B', { markRead: false })).toHaveLength(1);
    expect(await bus.checkMessages('B', { markRead: false })).toHaveLength(1);
    expect(await bus.checkMessages('B')).toHaveLength(1);
    expect(await bus.checkMessages('B')).toHaveLength(0);
  });

  it('keeps the bus file valid under concurrent interleaved sends', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('B');

    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        bus.send(`sender-${String(index)}`, 'B', `msg ${String(index)}`, 'coder'),
      ),
    );

    const raw = await readFile(busPath, 'utf8');
    const parsed = JSON.parse(raw) as { messages: { id: number }[]; nextId: number };
    expect(parsed.messages).toHaveLength(count);
    const ids = parsed.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(count);
    expect(parsed.nextId).toBe(count + 1);

    const delivered = await bus.checkMessages('B');
    expect(delivered).toHaveLength(count);
  });

  it('throws when sending to an unknown handle', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('A', 'main');
    await expect(bus.send('A', 'ghost', 'anyone?')).rejects.toBeInstanceOf(UnknownRecipientError);
  });

  it('lists registered agents with unread counts', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('A', 'main');
    await bus.register('B', 'coder');
    await bus.send('A', 'B', 'one');
    await bus.send('A', 'B', 'two');

    const roster = await bus.listAgents();
    expect(roster.map((entry) => entry.handle)).toEqual(['A', 'B']);
    const b = roster.find((entry) => entry.handle === 'B');
    expect(b?.unread).toBe(2);
    expect(b?.description).toBe('coder');
  });
});

describe('comms tools', () => {
  it('SendMessage delivers and CheckMessages retrieves it', async () => {
    const check = new CheckMessagesTool(() => ref('main'));
    const send = new SendMessageTool(() => ref('coder-abc', 'coder'));

    // Register the recipient ('main') by checking its (empty) inbox first.
    const empty = await executeTool(check, {
      turnId: '0',
      toolCallId: 'c0',
      args: {},
      signal,
    });
    expect(empty.output).toContain("No new messages for 'main'");

    const sent = await executeTool(send, {
      turnId: '0',
      toolCallId: 's0',
      args: { to: 'main', content: 'ping from coder' },
      signal,
    });
    expect(sent.isError).not.toBe(true);
    expect(sent.output).toContain("sent as 'coder-abc' to 'main'");

    const received = await executeTool(check, {
      turnId: '0',
      toolCallId: 'c1',
      args: {},
      signal,
    });
    expect(received.output).toContain('ping from coder');
    expect(received.output).toContain('from coder-abc');
  });

  it('SendMessage rejects an unknown recipient', async () => {
    const send = new SendMessageTool(() => ref('main'));
    const result = await executeTool(send, {
      turnId: '0',
      toolCallId: 's1',
      args: { to: 'nobody', content: 'hi' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('ListAgents');
  });

  it('SendMessage refuses messaging yourself', async () => {
    const send = new SendMessageTool(() => ref('main'));
    const result = await executeTool(send, {
      turnId: '0',
      toolCallId: 's2',
      args: { to: 'main', content: 'self' },
      signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('cannot send a message to yourself');
  });

  it('ListAgents shows registered agents', async () => {
    const bus = new MessageBus(busPath);
    await bus.register('coder-1', 'coder');

    const list = new ListAgentsTool(() => ref('main'));
    const result = await executeTool(list, {
      turnId: '0',
      toolCallId: 'l0',
      args: {},
      signal,
    });
    expect(result.output).toContain('coder-1');
    expect(result.output).toContain('main');
  });
});

describe('deriveCommsHandle', () => {
  it('names the main agent "main"', () => {
    expect(deriveCommsHandle({ type: 'main' })).toBe('main');
  });

  it('builds <profile>-<idPrefix> for subagents', () => {
    expect(deriveCommsHandle({ type: 'sub', profileName: 'coder', agentId: 'abcdef123' })).toBe(
      'coder-abcdef',
    );
    expect(deriveCommsHandle({ type: 'sub' })).toBe('agent-0');
  });
});
