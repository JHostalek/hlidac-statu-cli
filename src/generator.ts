import type { Command } from 'commander';
import { hlidacRequest, type QueryValue } from './api.js';
import { type CliOutcome, emitOutcome, formatEnvelope, formatOutcome } from './output.js';

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: { type?: string; default?: unknown; enum?: unknown[] };
}

interface Operation {
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: unknown;
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, Operation>>;
}

export interface CommandPlan {
  tree: string[];
  pathParams: Parameter[];
  queryParams: Parameter[];
  hasRequestBody: boolean;
  method: string;
  path: string;
  summary?: string;
}

// Internal: stashed on each leaf Commander command so `hs schema` can read the
// full param metadata back without re-parsing OpenAPI.
type CommandWithPlan = Command & { __plan?: CommandPlan };
export function getPlan(cmd: Command): CommandPlan | undefined {
  return (cmd as CommandWithPlan).__plan;
}
function setPlan(cmd: Command, plan: CommandPlan): void {
  (cmd as CommandWithPlan).__plan = plan;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function stripV2Prefix(path: string): string {
  return path.replace(/^\/api\/v2/, '') || '/';
}

export function cleanHelp(text?: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function placeholderFor(type?: string): string {
  if (type === 'integer' || type === 'number') return '<integer>';
  if (type === 'boolean') return '<true|false>';
  return '<value>';
}

function describeParam(p: Parameter): string {
  const facets: string[] = [];
  const t = p.schema?.type;
  if (t) facets.push(t);
  if (p.required) facets.push('required');
  if (p.schema?.default !== undefined) facets.push(`default ${String(p.schema.default)}`);
  if (Array.isArray(p.schema?.enum) && p.schema.enum.length > 0) {
    facets.push(`enum: ${p.schema.enum.map(String).join('|')}`);
  }
  const prefix = facets.length > 0 ? `(${facets.join(', ')}) ` : '';
  return `${prefix}${cleanHelp(p.description)}`.trim();
}

export function planCommand(path: string, method: string, op: Operation): CommandPlan {
  const rel = stripV2Prefix(path);
  const segments = rel.split('/').filter(Boolean);
  const literals: string[] = [];
  const pathParamNames: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith('{') && seg.endsWith('}')) pathParamNames.push(seg.slice(1, -1));
    else literals.push(seg);
  }
  const lastIsParam = segments.length > 0 && segments[segments.length - 1].startsWith('{');
  const methodLower = method.toLowerCase();

  const tree = [...literals];
  if (lastIsParam) {
    tree.push(methodLower);
  } else if (methodLower !== 'get') {
    tree.push(methodLower);
  }

  const params = op.parameters ?? [];
  const queryParams = params.filter((p) => p.in === 'query');
  const declaredPathParams = params.filter((p) => p.in === 'path');
  const pathParams: Parameter[] = pathParamNames.map(
    (name) =>
      declaredPathParams.find((p) => p.name === name) ?? {
        name,
        in: 'path',
        required: true,
      },
  );

  return {
    tree,
    pathParams,
    queryParams,
    hasRequestBody: op.requestBody !== undefined,
    method: method.toUpperCase(),
    path: rel,
    summary: op.summary,
  };
}

function findOrCreateNested(program: Command, pathToHere: string[]): Command {
  let node: Command = program;
  for (const name of pathToHere) {
    const existing = node.commands.find((c) => c.name() === name);
    if (existing) {
      node = existing;
    } else {
      node = node.command(name);
    }
  }
  return node;
}

function attachAction(cmd: Command, plan: CommandPlan): void {
  for (const p of plan.pathParams) {
    const desc = describeParam(p);
    if (desc.length > 0) cmd.argument(`<${p.name}>`, desc);
    else cmd.argument(`<${p.name}>`);
  }

  for (const q of plan.queryParams) {
    const type = q.schema?.type;
    const flag = `--${q.name} ${placeholderFor(type)}`;
    const desc = describeParam(q);
    if (type === 'integer' || type === 'number') {
      cmd.option(flag, desc, (v) => Number.parseInt(String(v), 10));
    } else if (type === 'boolean') {
      cmd.option(flag, desc, (v) => v === 'true' || v === '1');
    } else {
      cmd.option(flag, desc);
    }
  }

  if (plan.hasRequestBody) {
    cmd.option('-d, --data <json>', 'JSON request body (parsed before send)');
  }

  cmd.action(async (...args: unknown[]) => {
    const positionals = args.slice(0, plan.pathParams.length).map(String);
    const opts = args[plan.pathParams.length] as Record<string, unknown>;
    const globals = cmd.optsWithGlobals();
    const dryRun = globals.dryRun === true;
    const json = globals.json === true || dryRun;
    const output = typeof globals.output === 'string' ? globals.output : undefined;

    let resolvedPath = plan.path;
    for (let i = 0; i < plan.pathParams.length; i++) {
      resolvedPath = resolvedPath.replace(`{${plan.pathParams[i].name}}`, encodeURIComponent(positionals[i]));
    }

    const query: Record<string, QueryValue> = {};
    for (const q of plan.queryParams) {
      const v = opts[q.name];
      if (v !== undefined) query[q.name] = v as QueryValue;
    }

    let body: unknown;
    if (plan.hasRequestBody && typeof opts.data === 'string') {
      try {
        body = JSON.parse(opts.data);
      } catch (err) {
        emitOutcome({
          stdout: '',
          stderr: `invalid --data JSON: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 2,
        });
      }
    }

    const result = await hlidacRequest(plan.method, resolvedPath, query, body, { dryRun });
    const outcome: CliOutcome = json ? formatEnvelope(result, { dryRun, output }) : formatOutcome(result, { output });
    emitOutcome(outcome);
  });

  setPlan(cmd, plan);
}

export interface RegisterResult {
  registered: number;
  skipped: { method: string; path: string; reason: string }[];
}

export function registerFromOpenApi(program: Command, spec: OpenApiSpec): RegisterResult {
  const actioned = new WeakSet<Command>();
  const result: RegisterResult = { registered: 0, skipped: [] };

  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const plan = planCommand(path, method, op);
      if (plan.tree.length === 0) {
        result.skipped.push({ method: method.toUpperCase(), path, reason: 'empty command tree' });
        continue;
      }

      const parentTree = plan.tree.slice(0, -1);
      const leafName = plan.tree[plan.tree.length - 1];
      const parent = findOrCreateNested(program, parentTree);
      const existing = parent.commands.find((c) => c.name() === leafName);

      if (existing) {
        if (actioned.has(existing)) {
          result.skipped.push({ method: method.toUpperCase(), path, reason: 'command name collision' });
          continue;
        }
        attachAction(existing, plan);
        actioned.add(existing);
        if (plan.summary) existing.description(cleanHelp(plan.summary));
      } else {
        const cmd = parent.command(leafName).description(cleanHelp(plan.summary) || `${plan.method} ${plan.path}`);
        attachAction(cmd, plan);
        actioned.add(cmd);
      }
      result.registered++;
    }
  }

  return result;
}
