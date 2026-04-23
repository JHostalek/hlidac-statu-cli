import type { Command } from 'commander';
import { hlidacRequest, type QueryValue } from './api.js';
import { emitOutcome, formatOutcome } from './output.js';

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: { type?: string; default?: unknown };
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
  pathParams: string[];
  queryParams: Parameter[];
  hasRequestBody: boolean;
  method: string;
  path: string;
  summary?: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function stripV2Prefix(path: string): string {
  return path.replace(/^\/api\/v2/, '') || '/';
}

function cleanHelp(text?: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function planCommand(path: string, method: string, op: Operation): CommandPlan {
  const rel = stripV2Prefix(path);
  const segments = rel.split('/').filter(Boolean);
  const literals: string[] = [];
  const pathParams: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith('{') && seg.endsWith('}')) pathParams.push(seg.slice(1, -1));
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
  for (let i = 0; i < pathToHere.length; i++) {
    const name = pathToHere[i];
    const existing = node.commands.find((c) => c.name() === name);
    if (existing) {
      node = existing;
    } else {
      node = node.command(name).description(`/${pathToHere.slice(0, i + 1).join('/')}`);
    }
  }
  return node;
}

function attachAction(cmd: Command, plan: CommandPlan): void {
  for (const p of plan.pathParams) cmd.argument(`<${p}>`);

  for (const q of plan.queryParams) {
    const type = q.schema?.type;
    const desc = cleanHelp(q.description);
    const flag = `--${q.name} <value>`;
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

    let resolvedPath = plan.path;
    for (let i = 0; i < plan.pathParams.length; i++) {
      resolvedPath = resolvedPath.replace(`{${plan.pathParams[i]}}`, encodeURIComponent(positionals[i]));
    }

    const query: Record<string, QueryValue> = {};
    for (const q of plan.queryParams) {
      const v = opts[q.name];
      if (v !== undefined) query[q.name] = v as QueryValue;
    }

    const body = plan.hasRequestBody && typeof opts.data === 'string' ? JSON.parse(opts.data) : undefined;

    emitOutcome(formatOutcome(await hlidacRequest(plan.method, resolvedPath, query, body)));
  });
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
