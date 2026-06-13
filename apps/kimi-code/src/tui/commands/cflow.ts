import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  cflowsDir,
  creationPrompt,
  deleteWorkflow,
  isValidName,
  listWorkflows,
  loadWorkflow,
  readWorkflowFile,
  runPrompt,
  workflowFileExists,
  workflowPath,
} from './cflow-store';
import type { SlashCommandHost } from './dispatch';

const CFLOW_USAGE = `Usage:
  /cflow create <name> <agents and tasks description>  - design & save a workflow
  /cflow run <name> <task>                             - run a workflow on a task
  /cflow list                                          - list saved workflows
  /cflow show <name>                                   - show a workflow definition
  /cflow delete <name>                                 - delete a workflow`;

/** Split a string into its first whitespace-delimited token and the trimmed remainder. */
function partition(input: string): readonly [string, string] {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  if (match === null) return ['', ''];
  return [match[1] ?? '', (match[2] ?? '').trim()];
}

function resolveHomeDir(host: SlashCommandHost): string {
  return host.harness?.homeDir ?? resolveKimiHome();
}

export function handleCflowCommand(host: SlashCommandHost, args: string): void {
  const [rawAction, rest] = partition(args);
  const action = rawAction.toLowerCase();

  if (action === '' || action === 'help') {
    host.showStatus(CFLOW_USAGE);
    return;
  }

  switch (action) {
    case 'list':
      listCflows(host);
      return;
    case 'show':
      showCflow(host, rest);
      return;
    case 'delete':
      deleteCflow(host, rest);
      return;
    case 'create':
      createCflow(host, rest);
      return;
    case 'run':
      runCflow(host, rest);
      return;
    default:
      host.showError(`Unknown action '${action}'.\n${CFLOW_USAGE}`);
      return;
  }
}

function listCflows(host: SlashCommandHost): void {
  const homeDir = resolveHomeDir(host);
  host.track('cflow_invoked', { action: 'list' });
  const workflows = listWorkflows(homeDir);
  if (workflows.length === 0) {
    host.showStatus(
      'No workflows saved yet. Create one with:\n  /cflow create <name> <agents and tasks description>',
    );
    return;
  }
  const lines = [`Saved workflows (${cflowsDir(homeDir)}):`];
  for (const workflow of workflows) {
    const handles = workflow.agents.map((agent) => agent.handle).join(', ');
    lines.push(`  - ${workflow.name}: ${workflow.description.length > 0 ? workflow.description : 'no description'}`);
    lines.push(`      agents (${workflow.agents.length}): ${handles}`);
  }
  host.showStatus(lines.join('\n'));
}

function showCflow(host: SlashCommandHost, rest: string): void {
  if (rest.length === 0) {
    host.showStatus('Usage: /cflow show <name>');
    return;
  }
  const homeDir = resolveHomeDir(host);
  try {
    const workflow = loadWorkflow(homeDir, rest);
    host.showStatus(readWorkflowFile(homeDir, workflow.name));
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

function deleteCflow(host: SlashCommandHost, rest: string): void {
  if (rest.length === 0) {
    host.showStatus('Usage: /cflow delete <name>');
    return;
  }
  const homeDir = resolveHomeDir(host);
  if (deleteWorkflow(homeDir, rest)) {
    host.track('cflow_invoked', { action: 'delete' });
    host.showStatus(`Workflow '${rest}' deleted.`);
    return;
  }
  host.showStatus(`Workflow '${rest}' not found.`);
}

function createCflow(host: SlashCommandHost, rest: string): void {
  const [name, spec] = partition(rest);
  if (name.length === 0 || spec.length === 0) {
    host.showStatus(
      'Usage: /cflow create <name> <agents and tasks description>\n' +
        'Example: /cflow create review-pipeline 3 agents: one builds the feature, one writes tests, one reviews both adversarially',
    );
    return;
  }
  if (!isValidName(name)) {
    host.showError(`Invalid workflow name '${name}'. Use letters, digits, '-' and '_' only.`);
    return;
  }
  const homeDir = resolveHomeDir(host);
  const path = workflowPath(homeDir, name);
  if (workflowFileExists(homeDir, name)) {
    host.showError(
      `Workflow '${name}' already exists. Delete it first with /cflow delete ${name}, or pick another name.`,
    );
    return;
  }
  if (!hasModelAndSession(host)) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  host.track('cflow_invoked', { action: 'create' });
  host.sendNormalUserInput(creationPrompt(name, spec, path));
}

function runCflow(host: SlashCommandHost, rest: string): void {
  const [name, task] = partition(rest);
  if (name.length === 0 || task.length === 0) {
    host.showStatus('Usage: /cflow run <name> <task>');
    return;
  }
  const homeDir = resolveHomeDir(host);
  let composed: string;
  try {
    composed = runPrompt(loadWorkflow(homeDir, name), task);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  if (!hasModelAndSession(host)) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  host.track('cflow_invoked', { action: 'run' });
  host.sendNormalUserInput(composed);
}

function hasModelAndSession(host: SlashCommandHost): boolean {
  return host.state.appState.model.trim().length > 0 && host.session !== undefined;
}
