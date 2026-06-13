import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { join } from 'pathe';
import { z } from 'zod';

/**
 * Reusable multi-agent workflows ("cflows").
 *
 * A cflow is a saved team of agents: each agent has a handle, a subagent type,
 * and a well-defined prompt template with a `{TASK}` placeholder. Workflows are
 * created once via `/cflow create` (the AI designs and writes the per-agent
 * prompts) and can then be applied to any task via `/cflow run <name> <task>`.
 *
 * Workflows are stored as YAML files under `<kimiHome>/cflows/`.
 */

export const TASK_PLACEHOLDER = '{TASK}';

/** One agent in a workflow. */
const workflowAgentSchema = z.object({
  /** Message-bus handle, unique within the workflow. */
  handle: z.string().min(1),
  /** Built-in subagent type to launch (coder / explore / plan). */
  subagent_type: z.string().default('coder'),
  /** Whether to launch the agent in the background (parallel). */
  run_in_background: z.boolean().default(true),
  /** Well-defined prompt template. `{TASK}` is replaced with the user's task. */
  prompt: z.string().min(1),
});

/** A saved multi-agent workflow. */
const workflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  agents: z.array(workflowAgentSchema).min(1),
  /** Optional notes on ordering, messaging, and integration of results. */
  coordination: z.string().default(''),
});

export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

/** Resolve (and create) the directory that holds workflow YAML files. */
export function cflowsDir(homeDir: string): string {
  const dir = join(homeDir, 'cflows');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to a workflow's YAML file. */
export function workflowPath(homeDir: string, name: string): string {
  return join(cflowsDir(homeDir), `${name}.yaml`);
}

/** A workflow name is valid when it contains only letters, digits, '-' and '_'. */
export function isValidName(name: string): boolean {
  return name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name);
}

/** Whether a workflow file exists on disk (regardless of whether it parses). */
export function workflowFileExists(homeDir: string, name: string): boolean {
  return existsSync(workflowPath(homeDir, name));
}

/** Read the raw YAML text of a workflow file. */
export function readWorkflowFile(homeDir: string, name: string): string {
  return readFileSync(workflowPath(homeDir, name), 'utf-8');
}

/**
 * Load a workflow by name.
 *
 * @throws {Error} If the workflow does not exist, is not valid YAML, fails
 *   schema validation, or has duplicate agent handles.
 */
export function loadWorkflow(homeDir: string, name: string): Workflow {
  const path = workflowPath(homeDir, name);
  if (!existsSync(path)) {
    throw new Error(`Workflow '${name}' not found at ${path}`);
  }

  let data: unknown;
  try {
    data = loadYaml(readFileSync(path, 'utf-8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow '${name}' is not valid YAML: ${detail}`, { cause: error });
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Workflow '${name}' must be a YAML mapping`);
  }

  const parsed = workflowSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Workflow '${name}' failed validation: ${parsed.error.message}`);
  }

  const workflow = parsed.data;
  const handles = workflow.agents.map((agent) => agent.handle);
  if (new Set(handles).size !== handles.length) {
    throw new Error(`Workflow '${name}' has duplicate agent handles`);
  }
  return workflow;
}

/** List every workflow that parses; invalid files are skipped. */
export function listWorkflows(homeDir: string): Workflow[] {
  const dir = cflowsDir(homeDir);
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .toSorted((a, b) => a.localeCompare(b));
  const workflows: Workflow[] = [];
  for (const file of files) {
    const name = file.slice(0, -'.yaml'.length);
    try {
      workflows.push(loadWorkflow(homeDir, name));
    } catch {
      // Skip files that fail to parse or validate; `/cflow show` surfaces them.
    }
  }
  return workflows;
}

/** Persist a workflow to disk and return the file path. */
export function saveWorkflow(homeDir: string, workflow: Workflow): string {
  const path = workflowPath(homeDir, workflow.name);
  writeFileSync(path, dumpYaml(workflow, { sortKeys: false, lineWidth: -1 }), 'utf-8');
  return path;
}

/** Delete a workflow; returns false when it did not exist. */
export function deleteWorkflow(homeDir: string, name: string): boolean {
  const path = workflowPath(homeDir, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Meta-prompt instructing the agent to design and save a workflow. */
export function creationPrompt(name: string, spec: string, path: string): string {
  return `The user wants to create a reusable multi-agent workflow named "${name}" using the /cflow system. Their rough specification of the agents and their tasks:

${spec}

Design the workflow now:

1. Decide the team: how many agents, a short lowercase handle for each (e.g. \`builder\`, \`critic\`, \`researcher\`), the right subagent type for the job (\`coder\` for implementation, \`explore\` for read-only research, \`plan\` for design), and whether it should run in the background (parallel) or not.
2. For EACH agent, write a well-defined, self-contained prompt template. This is the most important part. Each prompt must include: the agent's role and responsibilities, its message-bus handle and which other handles it should coordinate with (via SendMessage / CheckMessages), what it must deliver, and quality constraints. Use the literal placeholder ${TASK_PLACEHOLDER} where the user's concrete task will be substituted at run time.
3. If the agents must work in a particular order or integrate results at the end, describe that in a \`coordination\` note.

Then save the workflow with the Write tool to exactly this path:

${path}

Use this YAML structure:

\`\`\`yaml
name: ${name}
description: "<one-line description of what this workflow is for>"
agents:
  - handle: <handle>
    subagent_type: <coder|explore|plan>
    run_in_background: <true|false>
    prompt: |
      <well-defined prompt template containing ${TASK_PLACEHOLDER}>
  - ...
coordination: |
  <optional ordering/integration notes>
\`\`\`

YAML correctness rules: always wrap one-line string values (\`description\`) in double quotes — unquoted scalars containing ':' break YAML parsing. Keep multi-line text (\`prompt\`, \`coordination\`) in \`|\` block scalars. After saving, verify the file parses by reading it back with the Read tool.

If the user's specification is ambiguous about the number of agents or their responsibilities, make sensible decisions yourself rather than asking — they can edit the file later. After saving, show the user a compact summary of the team and tell them to run it with: /cflow run ${name} <task>`;
}

/** Compose the orchestration prompt for running a workflow on a task. */
export function runPrompt(workflow: Workflow, task: string): string {
  const sections: string[] = [
    `Execute the saved multi-agent workflow "${workflow.name}" (${
      workflow.description.length > 0 ? workflow.description : 'no description'
    }) on the following task:\n\n<task>\n${task}\n</task>\n\nLaunch the following ${
      workflow.agents.length
    } agent(s) with the Agent tool, using exactly the prompts below. Tell each agent its message-bus handle as written (they coordinate via SendMessage / CheckMessages).`,
  ];

  workflow.agents.forEach((agent, index) => {
    const prompt = agent.prompt.includes(TASK_PLACEHOLDER)
      ? agent.prompt.replaceAll(TASK_PLACEHOLDER, task)
      : `${agent.prompt}\n\nCurrent task: ${task}`;
    const mode = agent.run_in_background ? 'background (parallel)' : 'foreground (blocking)';
    sections.push(
      `--- Agent ${index + 1}: ${agent.handle} (subagent_type=${agent.subagent_type}, ${mode}) ---\n${prompt}`,
    );
  });

  if (workflow.coordination.trim().length > 0) {
    const coordination = workflow.coordination.trim().replaceAll(TASK_PLACEHOLDER, task);
    sections.push(`--- Coordination ---\n${coordination}`);
  }

  sections.push(
    'Monitor the agents with TaskList/TaskOutput and the message bus. When all agents have finished, integrate their results and report a consolidated outcome for the task.',
  );

  return sections.join('\n\n');
}
