/**
 * Decentralized inter-agent messaging over a shared, file-locked bus.
 *
 * Every agent that shares the same working directory — the main agent, its
 * subagents at any depth, and even separate kimi-code processes — exchanges
 * messages through one JSON file guarded by an OS-level lock (proper-lockfile).
 * Coordination is file-based, so no server is required and messages survive
 * process restarts.
 *
 * Mirrors the sibling Python design (`kimi_cli/tools/comms`): a registry of
 * agents keyed by handle plus an append-only list of messages. Unread tracking
 * here uses a per-message `read` flag because every message is addressed to a
 * single recipient handle.
 */

import { mkdir, readFile } from 'node:fs/promises';

import { dirname, join } from 'pathe';
import lockfile from 'proper-lockfile';

import { atomicWrite } from '../../../../utils/fs';

/** Cap on retained messages so the bus file cannot grow without bound. */
export const MAX_MESSAGES = 1000;

const LOCK_OPTIONS: Parameters<typeof lockfile.lock>[1] = {
  // proper-lockfile locks `<busPath>.lock`; the bus file itself need not exist.
  realpath: false,
  // Generous retries so heavily-interleaved in-process and cross-process writes
  // serialize rather than fail with ELOCKED.
  retries: { retries: 60, factor: 1.5, minTimeout: 8, maxTimeout: 250, randomize: true },
  stale: 15_000,
};

export interface BusMessage {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly ts: number;
  read: boolean;
}

export interface BusAgentInfo {
  description?: string;
  lastSeen: number;
}

export interface RosterEntry {
  readonly handle: string;
  readonly description?: string;
  readonly lastSeen: number;
  readonly unread: number;
}

interface BusState {
  agents: Record<string, BusAgentInfo>;
  messages: BusMessage[];
  nextId: number;
}

/** Identity + bus location for the agent operating a set of comms tools. */
export interface CommsAgentRef {
  readonly handle: string;
  readonly role: string;
  readonly busPath: string;
}

/** Raised by {@link MessageBus.send} when the recipient handle is not on the bus. */
export class UnknownRecipientError extends Error {
  constructor(readonly recipient: string) {
    super(`Unknown recipient "${recipient}". Use ListAgents to see who is on the message bus.`);
    this.name = 'UnknownRecipientError';
  }
}

/** Resolve the shared bus file for a working directory. */
export function resolveCommsBusPath(cwd: string): string {
  return join(cwd, '.kimi-code', 'comms', 'bus.json');
}

/**
 * Derive a stable, human-readable handle for an agent.
 *
 * The main agent is always `main`; subagents become `<profile>-<idPrefix>` so
 * sibling subagents of the same type stay distinguishable.
 */
export function deriveCommsHandle(input: {
  readonly type: string;
  readonly profileName?: string | undefined;
  readonly agentId?: string | undefined;
}): string {
  if (input.type === 'main') return 'main';
  const profile = input.profileName && input.profileName.length > 0 ? input.profileName : 'agent';
  const suffix = (input.agentId ?? '').slice(0, 6) || '0';
  return `${profile}-${suffix}`;
}

export class MessageBus {
  constructor(private readonly path: string) {}

  /** Register (or refresh) an agent on the bus, optionally setting a description. */
  async register(handle: string, description?: string): Promise<void> {
    await this.mutate((state) => {
      touchAgent(state, handle, description);
    });
  }

  /** Snapshot of every registered agent with its current unread count. */
  async listAgents(): Promise<RosterEntry[]> {
    const state = await readState(this.path);
    return Object.entries(state.agents)
      .map(([handle, info]) => {
        const entry: RosterEntry = {
          handle,
          ...(info.description !== undefined ? { description: info.description } : {}),
          lastSeen: info.lastSeen,
          unread: countUnread(state, handle),
        };
        return entry;
      })
      .toSorted((a, b) => a.handle.localeCompare(b.handle));
  }

  /**
   * Deliver `content` from `from` to `to`. Registers the sender. Throws
   * {@link UnknownRecipientError} if the recipient is not registered.
   */
  async send(
    from: string,
    to: string,
    content: string,
    fromDescription?: string,
  ): Promise<BusMessage> {
    return this.mutate((state) => {
      touchAgent(state, from, fromDescription);
      if (state.agents[to] === undefined) {
        throw new UnknownRecipientError(to);
      }
      const message: BusMessage = {
        id: state.nextId,
        from,
        to,
        content,
        ts: Date.now(),
        read: false,
      };
      state.nextId += 1;
      state.messages.push(message);
      if (state.messages.length > MAX_MESSAGES) {
        state.messages = state.messages.slice(-MAX_MESSAGES);
      }
      return message;
    });
  }

  /**
   * Return unread messages addressed to `handle`. Registers the handle. When
   * `markRead` is true (default) the returned messages are flagged read so a
   * later call does not re-deliver them.
   */
  async checkMessages(
    handle: string,
    options?: { readonly markRead?: boolean; readonly description?: string },
  ): Promise<BusMessage[]> {
    const markRead = options?.markRead ?? true;
    return this.mutate((state) => {
      touchAgent(state, handle, options?.description);
      const delivered: BusMessage[] = [];
      for (const message of state.messages) {
        if (message.to !== handle || message.read) continue;
        delivered.push({ ...message });
        if (markRead) message.read = true;
      }
      return delivered;
    });
  }

  /** Acquire the cross-process lock, read-modify-write the bus atomically. */
  private async mutate<T>(fn: (state: BusState) => T): Promise<T> {
    const release = await acquireLock(this.path);
    try {
      const state = await readState(this.path);
      const result = fn(state);
      await writeState(this.path, state);
      return result;
    } finally {
      await release();
    }
  }
}

function touchAgent(state: BusState, handle: string, description?: string): void {
  const existing = state.agents[handle] ?? { lastSeen: 0 };
  existing.lastSeen = Date.now();
  if (description !== undefined && description.length > 0) {
    existing.description = description;
  }
  state.agents[handle] = existing;
}

function countUnread(state: BusState, handle: string): number {
  let count = 0;
  for (const message of state.messages) {
    if (message.to === handle && !message.read) count += 1;
  }
  return count;
}

async function acquireLock(busPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(busPath), { recursive: true });
  return lockfile.lock(busPath, LOCK_OPTIONS);
}

async function readState(busPath: string): Promise<BusState> {
  let raw: string;
  try {
    raw = await readFile(busPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  if (raw.trim().length === 0) return emptyState();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  return normalizeState(data);
}

async function writeState(busPath: string, state: BusState): Promise<void> {
  await atomicWrite(busPath, JSON.stringify(state, null, 2));
}

function emptyState(): BusState {
  return { agents: {}, messages: [], nextId: 1 };
}

function normalizeState(data: unknown): BusState {
  const state = emptyState();
  if (typeof data !== 'object' || data === null) return state;
  const record = data as Record<string, unknown>;
  if (typeof record['agents'] === 'object' && record['agents'] !== null) {
    state.agents = record['agents'] as Record<string, BusAgentInfo>;
  }
  if (Array.isArray(record['messages'])) {
    state.messages = record['messages'] as BusMessage[];
  }
  if (typeof record['nextId'] === 'number' && Number.isFinite(record['nextId'])) {
    state.nextId = record['nextId'];
  }
  return state;
}
