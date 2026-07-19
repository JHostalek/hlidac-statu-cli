import type { Command } from 'commander';
import { type CommandPlan, cleanHelp, getPlan } from '../generator.js';

interface ParamEntry {
  name: string;
  type?: string;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  description?: string;
}

interface SchemaEntry {
  path: string[];
  method: string;
  httpPath: string;
  summary?: string;
  pathParams: ParamEntry[];
  queryParams: ParamEntry[];
  hasRequestBody: boolean;
}

function paramEntry(p: {
  name: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; default?: unknown; enum?: unknown[] };
}): ParamEntry {
  const cleaned = cleanHelp(p.description);
  return {
    name: p.name,
    type: p.schema?.type,
    required: p.required === true,
    default: p.schema?.default,
    enum: p.schema?.enum,
    description: cleaned.length > 0 ? cleaned : undefined,
  };
}

function planToEntry(plan: CommandPlan, path: string[]): SchemaEntry {
  const summary = cleanHelp(plan.summary);
  return {
    path,
    method: plan.method,
    httpPath: plan.path,
    summary: summary.length > 0 ? summary : undefined,
    pathParams: plan.pathParams.map(paramEntry),
    queryParams: plan.queryParams.map(paramEntry),
    hasRequestBody: plan.hasRequestBody,
  };
}

export function collectSchema(root: Command): SchemaEntry[] {
  const out: SchemaEntry[] = [];
  const visit = (node: Command, trail: string[]): void => {
    for (const child of node.commands) {
      const childTrail = [...trail, child.name()];
      const plan = getPlan(child);
      if (plan) out.push(planToEntry(plan, childTrail));
      visit(child, childTrail);
    }
  };
  visit(root, []);
  return out;
}

export function registerSchema(program: Command): void {
  program
    .command('schema')
    .description('Print the registered command tree as JSON (one entry per leaf endpoint)')
    .action(() => {
      const entries = collectSchema(program);
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      process.exit(0);
    });
}
