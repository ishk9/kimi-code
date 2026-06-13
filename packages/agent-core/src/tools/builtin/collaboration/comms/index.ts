/**
 * Inter-agent messaging tools: SendMessage, CheckMessages, ListAgents.
 *
 * These are low-risk "collaboration" tools (like AgentTool). Each takes a
 * closure that resolves the current agent's bus identity at execution time —
 * the working directory and profile name are not stable when the tool is
 * constructed, so the handle and bus path are resolved lazily per call.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../../agent/tool';
import { ToolAccesses } from '../../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../../loop/types';
import { toInputJsonSchema } from '../../../support/input-schema';
import { ToolResultBuilder } from '../../../support/result-builder';
import { literalRulePattern, matchesGlobRuleSubject } from '../../../support/rule-match';
import { MessageBus, UnknownRecipientError, type CommsAgentRef } from './message-bus';

export * from './message-bus';

type ResolveCommsRef = () => CommsAgentRef;

function formatMessage(message: { from: string; content: string; ts: number; id: number }): string {
  const stamp = new Date(message.ts).toISOString().slice(11, 19);
  return `[#${String(message.id)}] from ${message.from} (${stamp})\n${message.content}`;
}

// ── SendMessage ──────────────────────────────────────────────────────

export const SendMessageInputSchema = z.object({
  to: z
    .string()
    .min(1)
    .describe(
      'Handle of the agent to message. The recipient must already be on the bus; use ListAgents to discover handles.',
    ),
  content: z.string().min(1).describe('The message body to deliver to the recipient.'),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

const SEND_MESSAGE_DESCRIPTION =
  'Send a message to another agent working in the same project. Delivers to a single recipient handle (use ListAgents to find handles); the recipient sees it on their next CheckMessages call. Messages persist on a shared, file-locked bus.';

export class SendMessageTool implements BuiltinTool<SendMessageInput> {
  readonly name = 'SendMessage' as const;
  readonly description = SEND_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageInputSchema);
  constructor(private readonly resolveRef: ResolveCommsRef) {}

  resolveExecution(args: SendMessageInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Messaging ${args.to}`,
      approvalRule: literalRulePattern(this.name, args.to),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.to),
      execute: () => this.execution(args),
    };
  }

  private async execution(args: SendMessageInput): Promise<ExecutableToolResult> {
    const ref = this.resolveRef();
    const builder = new ToolResultBuilder({ maxLineLength: null });
    if (args.to === ref.handle) {
      return builder.error('You cannot send a message to yourself.', {
        brief: 'Invalid recipient',
      });
    }
    const bus = new MessageBus(ref.busPath);
    try {
      const message = await bus.send(ref.handle, args.to, args.content, ref.role);
      builder.write(
        `Message #${String(message.id)} sent as '${ref.handle}' to '${args.to}'. ` +
          'They will see it on their next CheckMessages call.',
      );
      return builder.ok();
    } catch (error) {
      if (error instanceof UnknownRecipientError) {
        return builder.error(error.message, { brief: 'Unknown recipient' });
      }
      return builder.error(error instanceof Error ? error.message : String(error));
    }
  }
}

// ── CheckMessages ────────────────────────────────────────────────────

export const CheckMessagesInputSchema = z.object({
  mark_read: z
    .boolean()
    .default(true)
    .describe(
      'Mark the returned messages as read so they are not delivered again. Defaults to true.',
    )
    .optional(),
});

export type CheckMessagesInput = z.infer<typeof CheckMessagesInputSchema>;

const CHECK_MESSAGES_DESCRIPTION =
  'Check your inbox on the shared message bus and read any messages other agents have sent you. By default the messages are marked read so they are not returned again.';

export class CheckMessagesTool implements BuiltinTool<CheckMessagesInput> {
  readonly name = 'CheckMessages' as const;
  readonly description = CHECK_MESSAGES_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CheckMessagesInputSchema);
  constructor(private readonly resolveRef: ResolveCommsRef) {}

  resolveExecution(args: CheckMessagesInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Checking messages',
      approvalRule: this.name,
      matchesRule: () => true,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: CheckMessagesInput): Promise<ExecutableToolResult> {
    const ref = this.resolveRef();
    const builder = new ToolResultBuilder({ maxLineLength: null });
    const bus = new MessageBus(ref.busPath);
    const messages = await bus.checkMessages(ref.handle, {
      markRead: args.mark_read ?? true,
      description: ref.role,
    });
    if (messages.length === 0) {
      builder.write(`No new messages for '${ref.handle}'.`);
      return builder.ok();
    }
    builder.write(`${String(messages.length)} new message(s) for '${ref.handle}':\n\n`);
    builder.write(messages.map((message) => formatMessage(message)).join('\n\n---\n\n'));
    return builder.ok();
  }
}

// ── ListAgents ───────────────────────────────────────────────────────

export const ListAgentsInputSchema = z.object({});

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;

const LIST_AGENTS_DESCRIPTION =
  'List the agent handles currently registered on the shared message bus, with their roles and unread counts. Agents appear here after their first SendMessage or CheckMessages call.';

export class ListAgentsTool implements BuiltinTool<ListAgentsInput> {
  readonly name = 'ListAgents' as const;
  readonly description = LIST_AGENTS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListAgentsInputSchema);
  constructor(private readonly resolveRef: ResolveCommsRef) {}

  resolveExecution(_args: ListAgentsInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Listing agents',
      approvalRule: this.name,
      matchesRule: () => true,
      execute: () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    const ref = this.resolveRef();
    const builder = new ToolResultBuilder({ maxLineLength: null });
    const bus = new MessageBus(ref.busPath);
    await bus.register(ref.handle, ref.role);
    const roster = await bus.listAgents();
    if (roster.length === 0) {
      builder.write(
        `No agents are registered on the message bus yet. Your handle is '${ref.handle}'.`,
      );
      return builder.ok();
    }
    builder.write(`Agents on the message bus (you are '${ref.handle}'):\n\n`);
    const now = Date.now();
    for (const entry of roster) {
      const seenAgo = Math.max(0, Math.round((now - entry.lastSeen) / 1000));
      const role = entry.description ?? '?';
      builder.write(
        `- ${entry.handle} (role: ${role}, last seen ${String(seenAgo)}s ago, unread: ${String(entry.unread)})\n`,
      );
    }
    return builder.ok();
  }
}
