import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cflowArgumentCompletions, handleCflowCommand } from '#/tui/commands/index';
import {
  creationPrompt,
  deleteWorkflow,
  isValidName,
  listWorkflows,
  loadWorkflow,
  runPrompt,
  saveWorkflow,
  workflowPath,
  type Workflow,
} from '#/tui/commands/cflow-store';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function sampleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: 'review-pipeline',
    description: 'Implement, test, and review a change',
    agents: [
      { handle: 'builder', subagent_type: 'coder', run_in_background: true, prompt: 'Build {TASK}' },
      { handle: 'tester', subagent_type: 'coder', run_in_background: false, prompt: 'Test it' },
    ],
    coordination: 'builder finishes first; tester reviews {TASK} last.',
    ...overrides,
  };
}

describe('cflow-store', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cflow-test-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('round-trips a workflow through save and load', () => {
    const workflow = sampleWorkflow();
    saveWorkflow(homeDir, workflow);
    expect(loadWorkflow(homeDir, workflow.name)).toEqual(workflow);
  });

  it('applies schema defaults when optional fields are omitted', () => {
    writeFileSync(
      workflowPath(homeDir, 'minimal'),
      ['name: minimal', 'agents:', '  - handle: solo', '    prompt: Do {TASK}'].join('\n'),
      'utf-8',
    );
    const workflow = loadWorkflow(homeDir, 'minimal');
    expect(workflow.description).toBe('');
    expect(workflow.coordination).toBe('');
    expect(workflow.agents[0]).toEqual({
      handle: 'solo',
      subagent_type: 'coder',
      run_in_background: true,
      prompt: 'Do {TASK}',
    });
  });

  it('throws when a workflow does not exist', () => {
    expect(() => loadWorkflow(homeDir, 'missing')).toThrow(/not found/);
  });

  it('throws when the YAML is not a mapping', () => {
    writeFileSync(workflowPath(homeDir, 'scalar'), 'just a string\n', 'utf-8');
    expect(() => loadWorkflow(homeDir, 'scalar')).toThrow(/must be a YAML mapping/);
  });

  it('throws when the workflow fails schema validation', () => {
    writeFileSync(workflowPath(homeDir, 'noagents'), 'name: noagents\nagents: []\n', 'utf-8');
    expect(() => loadWorkflow(homeDir, 'noagents')).toThrow(/failed validation/);
  });

  it('throws when agent handles are duplicated', () => {
    writeFileSync(
      workflowPath(homeDir, 'dupes'),
      [
        'name: dupes',
        'agents:',
        '  - handle: same',
        '    prompt: A {TASK}',
        '  - handle: same',
        '    prompt: B {TASK}',
      ].join('\n'),
      'utf-8',
    );
    expect(() => loadWorkflow(homeDir, 'dupes')).toThrow(/duplicate agent handles/);
  });

  it('lists valid workflows and skips invalid ones', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'alpha' }));
    saveWorkflow(homeDir, sampleWorkflow({ name: 'beta' }));
    writeFileSync(workflowPath(homeDir, 'broken'), 'name: broken\nagents: []\n', 'utf-8');

    const names = listWorkflows(homeDir).map((workflow) => workflow.name);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('deletes workflows and reports whether one existed', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'gone' }));
    expect(deleteWorkflow(homeDir, 'gone')).toBe(true);
    expect(deleteWorkflow(homeDir, 'gone')).toBe(false);
  });

  it('validates workflow names', () => {
    expect(isValidName('review-pipeline_2')).toBe(true);
    expect(isValidName('')).toBe(false);
    expect(isValidName('has space')).toBe(false);
    expect(isValidName('bad/name')).toBe(false);
  });

  it('substitutes the task into each agent prompt in runPrompt', () => {
    const prompt = runPrompt(sampleWorkflow(), 'add rate limiting');
    expect(prompt).toContain('Build add rate limiting');
    // The tester prompt has no {TASK}, so the task is appended.
    expect(prompt).toContain('Test it\n\nCurrent task: add rate limiting');
    expect(prompt).toContain('builder finishes first; tester reviews add rate limiting last.');
    expect(prompt).toContain('subagent_type=coder, background (parallel)');
    expect(prompt).toContain('subagent_type=coder, foreground (blocking)');
  });

  it('builds a creation meta-prompt referencing the name, spec, and save path', () => {
    const path = workflowPath(homeDir, 'review-pipeline');
    const prompt = creationPrompt('review-pipeline', 'one builder, one critic', path);
    expect(prompt).toContain('review-pipeline');
    expect(prompt).toContain('one builder, one critic');
    expect(prompt).toContain(path);
    expect(prompt).toContain('{TASK}');
    expect(prompt).toContain('Write tool');
  });
});

function makeHost(
  overrides: { model?: string; hasSession?: boolean; homeDir?: string } = {},
): { host: SlashCommandHost; session: object } {
  const session = {};
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: { model: overrides.model ?? 'kimi-model' },
    },
    session: hasSession ? session : undefined,
    harness: { homeDir: overrides.homeDir ?? '' },
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

function lastStatus(host: SlashCommandHost): string {
  const mock = host.showStatus as ReturnType<typeof vi.fn>;
  return (mock.mock.calls.at(-1)?.[0] as string) ?? '';
}

function lastInput(host: SlashCommandHost): string {
  const mock = host.sendNormalUserInput as ReturnType<typeof vi.fn>;
  return (mock.mock.calls.at(-1)?.[0] as string) ?? '';
}

describe('handleCflowCommand', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cflow-cmd-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('prints usage for an empty command and for help', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, '');
    expect(lastStatus(host)).toContain('/cflow create');
    handleCflowCommand(host, 'help');
    expect(lastStatus(host)).toContain('/cflow run');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('guides the user when no workflows exist', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'list');
    expect(host.track).toHaveBeenCalledWith('cflow_invoked', { action: 'list' });
    expect(lastStatus(host)).toContain('No workflows saved yet');
  });

  it('lists saved workflows with their agent handles', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'review-pipeline' }));
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'list');
    const text = lastStatus(host);
    expect(text).toContain('review-pipeline');
    expect(text).toContain('builder, tester');
  });

  it('rejects an invalid workflow name on create', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'create bad/name some agents here');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Invalid workflow name'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('rejects creating a workflow that already exists', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'review-pipeline' }));
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'create review-pipeline three agents please');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows usage when create is missing a spec', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'create only-a-name');
    expect(lastStatus(host)).toContain('Usage: /cflow create');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('triggers a turn with a creation prompt containing the name and spec', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'create review-pipeline one builder, one critic');
    expect(host.track).toHaveBeenCalledWith('cflow_invoked', { action: 'create' });
    const input = lastInput(host);
    expect(input).toContain('review-pipeline');
    expect(input).toContain('one builder, one critic');
    expect(input).toContain(workflowPath(homeDir, 'review-pipeline'));
  });

  it('does not start a creation turn without a configured model or session', () => {
    const { host: noModel } = makeHost({ homeDir, model: '' });
    handleCflowCommand(noModel, 'create review-pipeline one builder, one critic');
    expect(noModel.showError).toHaveBeenCalled();
    expect(noModel.sendNormalUserInput).not.toHaveBeenCalled();

    const { host: noSession } = makeHost({ homeDir, hasSession: false });
    handleCflowCommand(noSession, 'create review-pipeline one builder, one critic');
    expect(noSession.showError).toHaveBeenCalled();
    expect(noSession.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('runs a workflow by substituting the task and starting a turn', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'review-pipeline' }));
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'run review-pipeline add rate limiting to the API client');
    expect(host.track).toHaveBeenCalledWith('cflow_invoked', { action: 'run' });
    const input = lastInput(host);
    expect(input).toContain('add rate limiting to the API client');
    expect(input).toContain('Build add rate limiting to the API client');
  });

  it('reports an error when running a missing workflow', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'run does-not-exist do something');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows usage when run is missing a task', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'run review-pipeline');
    expect(lastStatus(host)).toContain('Usage: /cflow run');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows the YAML for an existing workflow', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'review-pipeline' }));
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'show review-pipeline');
    expect(lastStatus(host)).toContain('name: review-pipeline');
  });

  it('deletes an existing workflow', () => {
    saveWorkflow(homeDir, sampleWorkflow({ name: 'review-pipeline' }));
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'delete review-pipeline');
    expect(host.track).toHaveBeenCalledWith('cflow_invoked', { action: 'delete' });
    expect(lastStatus(host)).toContain("'review-pipeline' deleted");
  });

  it('reports an unknown action', () => {
    const { host } = makeHost({ homeDir });
    handleCflowCommand(host, 'frobnicate stuff');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining("Unknown action 'frobnicate'"));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});

describe('cflowArgumentCompletions', () => {
  function values(prefix: string): string[] | null {
    const items = cflowArgumentCompletions(prefix);
    return items === null ? null : items.map((item) => item.value);
  }

  it('offers every subcommand for an empty prefix', () => {
    expect(values('')).toEqual(['create', 'run', 'list', 'show', 'delete']);
  });

  it('prefix-filters subcommands', () => {
    expect(values('l')).toEqual(['list']);
    expect(values('s')).toEqual(['show']);
  });

  it('stops completing past the first token', () => {
    expect(values('run review-pipeline')).toBeNull();
  });
});
