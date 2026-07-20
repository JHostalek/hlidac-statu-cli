import type { Command } from 'commander';
import { hlidacRequest, type QueryValue } from './api.js';
import { type CliOutcome, emitOutcome, formatEnvelope, formatOutcome } from './output.js';

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
}

export type JsonSchema = boolean | Record<string, unknown>;

interface MediaType {
  schema?: JsonSchema;
}

interface RequestBody {
  required?: boolean;
  description?: string;
  content?: Record<string, MediaType>;
}

interface Response {
  description?: string;
  content?: Record<string, MediaType>;
}

interface Operation {
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, Response>;
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface RequestBodyPlan {
  required: boolean;
  description?: string;
  contentTypes: string[];
  schema: JsonSchema;
}

export interface ResponsePlan {
  status: string;
  description?: string;
  contentTypes: string[];
  schema?: JsonSchema;
}

export interface CommandPlan {
  tree: string[];
  registration: 'generated' | 'raw';
  pathParams: Parameter[];
  queryParams: Parameter[];
  hasRequestBody: boolean;
  method: string;
  path: string;
  summary?: string;
  requestBody?: RequestBodyPlan;
  responses: ResponsePlan[];
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const OPENAPI_OPERATION_METHODS = new Set([...HTTP_METHODS, 'head', 'options', 'trace']);
const RAW_FALLBACK_ROOT_COMMANDS = new Set(['raw', 'schema']);
const RESERVED_COMMAND_SEGMENTS = new Set(['help', 'version', 'completions', 'wizard']);
const RESERVED_OPTION_NAMES = new Set([
  'json',
  'dry-run',
  'output',
  'timeout',
  'help',
  'version',
  'completions',
  'wizard',
  'log-level',
]);

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

function schemaRecord(schema: JsonSchema | undefined): Record<string, unknown> | undefined {
  return typeof schema === 'object' && schema !== null ? schema : undefined;
}

function describeParam(p: Parameter): string {
  const facets: string[] = [];
  const schema = schemaRecord(p.schema);
  const type = typeof schema?.type === 'string' ? schema.type : undefined;
  if (type) facets.push(type);
  if (p.required) facets.push('required');
  if (schema?.default !== undefined) facets.push(`default ${String(schema.default)}`);
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    facets.push(`enum: ${schema.enum.map(String).join('|')}`);
  }
  const prefix = facets.length > 0 ? `(${facets.join(', ')}) ` : '';
  return `${prefix}${cleanHelp(p.description)}`.trim();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function dereferenceSchema(
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  resolving = new Set<string>(),
): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  const reference = schema.$ref;
  if (typeof reference === 'string' && reference.startsWith('#/components/schemas/')) {
    const name = reference.slice('#/components/schemas/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
    const resolved = schemas[name];
    if (resolved === undefined || resolving.has(name)) return schema;
    const nextResolving = new Set(resolving).add(name);
    return dereferenceSchema(resolved, schemas, nextResolving);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [
          key,
          value.map((item) =>
            typeof item === 'object' && item !== null
              ? dereferenceSchema(item as JsonSchema, schemas, resolving)
              : item,
          ),
        ];
      }
      return [
        key,
        typeof value === 'object' && value !== null
          ? dereferenceSchema(value as JsonSchema, schemas, resolving)
          : value,
      ];
    }),
  );
}

function planRequestBody(
  body: RequestBody | undefined,
  schemas: Record<string, JsonSchema>,
): RequestBodyPlan | undefined {
  if (body === undefined) return undefined;
  const content = body.content ?? {};
  const contentTypes = Object.keys(content).sort();
  const mediaSchemas = contentTypes.map((contentType) => content[contentType].schema ?? {});
  const schema = mediaSchemas[0] ?? {};
  const canonical = JSON.stringify(canonicalize(schema));
  if (mediaSchemas.some((candidate) => JSON.stringify(canonicalize(candidate)) !== canonical)) {
    throw new Error('request body media types declare different schemas');
  }
  const description = cleanHelp(body.description);
  return {
    required: body.required === true,
    description: description.length > 0 ? description : undefined,
    contentTypes,
    schema: dereferenceSchema(schema, schemas),
  };
}

function planResponses(responses: Record<string, Response> | undefined): ResponsePlan[] {
  return Object.entries(responses ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([status, response]) => {
      const content = response.content ?? {};
      const contentTypes = Object.keys(content).sort();
      const mediaSchemas = contentTypes
        .map((contentType) => content[contentType].schema)
        .filter((schema) => schema !== undefined);
      const schema = mediaSchemas[0];
      if (
        schema !== undefined &&
        mediaSchemas.some(
          (candidate) => JSON.stringify(canonicalize(candidate)) !== JSON.stringify(canonicalize(schema)),
        )
      ) {
        throw new Error(`response ${status} media types declare different schemas`);
      }
      const description = cleanHelp(response.description);
      return {
        status,
        description: description.length > 0 ? description : undefined,
        contentTypes,
        schema,
      };
    });
}

export function planCommand(
  path: string,
  method: string,
  op: Operation,
  schemas: Record<string, JsonSchema> = {},
): CommandPlan {
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

  const params = (op.parameters ?? []).map((parameter) => ({
    ...parameter,
    schema: parameter.schema === undefined ? undefined : dereferenceSchema(parameter.schema, schemas),
  }));
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
    registration: 'generated',
    pathParams,
    queryParams,
    hasRequestBody: op.requestBody !== undefined,
    method: method.toUpperCase(),
    path: rel,
    summary: op.summary,
    requestBody: planRequestBody(op.requestBody, schemas),
    responses: planResponses(op.responses),
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
    const schema = schemaRecord(q.schema);
    const type = typeof schema?.type === 'string' ? schema.type : undefined;
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
}

export interface RegisterResult {
  registered: number;
  skipped: { method: string; path: string; reason: string }[];
}

export type CommandPlanValidationCode =
  | 'AMBIGUOUS_COMMAND_PATH'
  | 'DUPLICATE_PARAMETER_NAME'
  | 'EMPTY_COMMAND_PATH'
  | 'RESERVED_COMMAND_NAME'
  | 'RESERVED_OPTION_NAME'
  | 'UNSUPPORTED_HTTP_METHOD'
  | 'UNSUPPORTED_OPTION_NAME';

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export class CommandPlanValidationError extends Error {
  constructor(
    readonly code: CommandPlanValidationCode,
    readonly commandPath: string[],
    readonly operations: string[],
    readonly parameter?: string,
  ) {
    super(`${code}: ${commandPath.join(' ')}`);
  }
}

function groupPlansByTree(plans: CommandPlan[]): Map<string, CommandPlan[]> {
  const groups = new Map<string, CommandPlan[]>();
  for (const plan of plans) {
    const key = plan.tree.join('\0');
    const group = groups.get(key);
    if (group) group.push(plan);
    else groups.set(key, [plan]);
  }

  return groups;
}

function disambiguatePlans(plans: CommandPlan[]): void {
  for (const group of groupPlansByTree(plans).values()) {
    if (group.length < 2) continue;
    const minimumParamCount = Math.min(...group.map((plan) => plan.pathParams.length));
    const bases = group.filter((plan) => plan.pathParams.length === minimumParamCount);
    if (bases.length !== 1) {
      throw new CommandPlanValidationError(
        'AMBIGUOUS_COMMAND_PATH',
        group[0].tree,
        group.map((plan) => `${plan.method} ${plan.path}`).sort(),
      );
    }
    const base = bases[0];
    const baseNames = new Set(base.pathParams.map((parameter) => parameter.name));

    for (const plan of group) {
      if (plan === base) continue;
      const additionalNames = plan.pathParams
        .map((parameter) => parameter.name)
        .filter((name) => !baseNames.has(name))
        .map(kebabCase)
        .filter(Boolean);
      if (additionalNames.length === 0) continue;
      const leaf = plan.tree.at(-1);
      if (leaf) plan.tree = [...plan.tree.slice(0, -1), `${leaf}-by-${additionalNames.join('-')}`];
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateUniqueCommandPaths(plans: CommandPlan[]): void {
  for (const group of groupPlansByTree(plans).values()) {
    if (group.length < 2) continue;
    throw new CommandPlanValidationError(
      'AMBIGUOUS_COMMAND_PATH',
      group[0].tree,
      group.map((plan) => `${plan.method} ${plan.path}`).sort(),
    );
  }
}

function routeAndValidateReservedPlans(plans: CommandPlan[]): void {
  for (const plan of plans) {
    const root = plan.tree[0];
    if (RAW_FALLBACK_ROOT_COMMANDS.has(root)) {
      plan.tree = ['raw', plan.method, plan.path];
      plan.registration = 'raw';
      continue;
    }
    if (!plan.tree.some((segment) => RESERVED_COMMAND_SEGMENTS.has(segment))) continue;
    throw new CommandPlanValidationError('RESERVED_COMMAND_NAME', plan.tree, [`${plan.method} ${plan.path}`]);
  }
}

function validateOptionNames(plans: CommandPlan[]): void {
  for (const plan of plans) {
    const operation = `${plan.method} ${plan.path}`;
    const seen = new Set<string>();
    for (const parameter of plan.queryParams) {
      if (seen.has(parameter.name)) {
        throw new CommandPlanValidationError('DUPLICATE_PARAMETER_NAME', plan.tree, [operation], parameter.name);
      }
      seen.add(parameter.name);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(parameter.name)) {
        throw new CommandPlanValidationError('UNSUPPORTED_OPTION_NAME', plan.tree, [operation], parameter.name);
      }
      if (RESERVED_OPTION_NAMES.has(parameter.name) || (plan.hasRequestBody && parameter.name === 'data')) {
        throw new CommandPlanValidationError('RESERVED_OPTION_NAME', plan.tree, [operation], parameter.name);
      }
    }
  }
}

export function planCommands(spec: OpenApiSpec): CommandPlan[] {
  const plans: CommandPlan[] = [];
  const schemas = spec.components?.schemas ?? {};
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const normalizedMethod = method.toLowerCase();
      if (!OPENAPI_OPERATION_METHODS.has(normalizedMethod)) continue;
      const plan = planCommand(path, method, operation, schemas);
      if (!HTTP_METHODS.has(normalizedMethod)) {
        throw new CommandPlanValidationError('UNSUPPORTED_HTTP_METHOD', plan.tree, [`${plan.method} ${plan.path}`]);
      }
      if (plan.tree.length === 0) {
        throw new CommandPlanValidationError('EMPTY_COMMAND_PATH', [], [`${plan.method} ${plan.path}`]);
      }
      plans.push(plan);
    }
  }
  routeAndValidateReservedPlans(plans);
  validateOptionNames(plans);
  disambiguatePlans(plans);
  validateUniqueCommandPaths(plans);
  return plans.sort(
    (left, right) =>
      compareText(left.tree.join('\0'), right.tree.join('\0')) ||
      compareText(left.method, right.method) ||
      compareText(left.path, right.path),
  );
}

export function registerPlans(program: Command, plans: CommandPlan[]): RegisterResult {
  const actioned = new WeakSet<Command>();
  const result: RegisterResult = { registered: 0, skipped: [] };

  for (const plan of plans) {
    if (plan.registration === 'raw') {
      result.skipped.push({ method: plan.method, path: plan.path, reason: 'available through hs raw' });
      continue;
    }
    const parentTree = plan.tree.slice(0, -1);
    const leafName = plan.tree[plan.tree.length - 1];
    const parent = findOrCreateNested(program, parentTree);
    const existing = parent.commands.find((c) => c.name() === leafName);

    if (existing) {
      if (actioned.has(existing)) {
        result.skipped.push({ method: plan.method, path: plan.path, reason: 'command name collision' });
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

  return result;
}

export function registerFromOpenApi(program: Command, spec: OpenApiSpec): RegisterResult {
  return registerPlans(program, planCommands(spec));
}
