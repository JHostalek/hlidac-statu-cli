import { schemaPathNotFound } from '../errors.js';
import { type CommandPlan, cleanHelp, type JsonSchema, type RequestBodyPlan, type ResponsePlan } from '../generator.js';

export interface ParamEntry {
  name: string;
  type?: string;
  schema?: JsonSchema;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  description?: string;
}

export interface SchemaEntry {
  path: string[];
  method: string;
  httpPath: string;
  summary?: string;
  pathParams: ParamEntry[];
  queryParams: ParamEntry[];
  hasRequestBody: boolean;
  requestBody?: RequestBodyPlan;
  responses: ResponsePlan[];
}

export interface SchemaDocument {
  schemaVersion: 1;
  cliVersion: string;
  globalOptions: { name: string; flags: string[]; type: 'boolean' | 'string' }[];
  errorCodes: readonly ErrorCode[];
  commands: SchemaEntry[];
}

const GLOBAL_OPTIONS: SchemaDocument['globalOptions'] = [
  { name: 'json', flags: ['--json'], type: 'boolean' },
  { name: 'dry-run', flags: ['--dry-run'], type: 'boolean' },
  { name: 'output', flags: ['-o', '--output'], type: 'string' },
  { name: 'timeout', flags: ['--timeout'], type: 'string' },
  { name: 'completions', flags: ['--completions'], type: 'string' },
  { name: 'log-level', flags: ['--log-level'], type: 'string' },
  { name: 'help', flags: ['-h', '--help'], type: 'boolean' },
  { name: 'wizard', flags: ['--wizard'], type: 'boolean' },
  { name: 'version', flags: ['--version'], type: 'boolean' },
];

export const ERROR_CODES = [
  'INVALID_INPUT',
  'MISSING_CREDENTIALS',
  'REQUEST_TIMEOUT',
  'TRANSPORT_FAILURE',
  'HTTP_FAILURE',
  'BINARY_OUTPUT_REQUIRED',
  'OUTPUT_FAILURE',
  'SCHEMA_PATH_NOT_FOUND',
  'INTERNAL_FAILURE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

function paramEntry(p: { name: string; required?: boolean; description?: string; schema?: JsonSchema }): ParamEntry {
  const cleaned = cleanHelp(p.description);
  const schema = typeof p.schema === 'object' && p.schema !== null ? p.schema : undefined;
  return {
    name: p.name,
    type: typeof schema?.type === 'string' ? schema.type : undefined,
    schema: p.schema,
    required: p.required === true,
    default: schema?.default,
    enum: Array.isArray(schema?.enum) ? schema.enum : undefined,
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
    ...(plan.requestBody ? { requestBody: plan.requestBody } : {}),
    responses: plan.responses,
  };
}

export function buildSchemaDocument(plans: CommandPlan[], cliVersion: string): SchemaDocument {
  return {
    schemaVersion: 1,
    cliVersion,
    globalOptions: GLOBAL_OPTIONS,
    errorCodes: ERROR_CODES,
    commands: plans.map((plan) => planToEntry(plan, plan.tree)),
  };
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length];
}

function schemaPathSuggestions(document: SchemaDocument, path: string[]): string[][] {
  const target = path.join('/');
  const candidates = new Map<string, string[]>();
  for (const command of document.commands) {
    const candidate = command.path.slice(0, path.length);
    if (candidate.length === path.length) candidates.set(candidate.join('/'), candidate);
  }
  return [...candidates.values()]
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate.join('/')) }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      const leftPath = left.candidate.join('/');
      const rightPath = right.candidate.join('/');
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    })
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

export function filterSchemaDocument(document: SchemaDocument, path: string[]): SchemaDocument {
  if (path.length === 0) return document;
  const commands = document.commands.filter((command) =>
    path.every((segment, index) => command.path[index] === segment),
  );
  if (commands.length === 0) {
    throw schemaPathNotFound(path, schemaPathSuggestions(document, path));
  }
  return {
    ...document,
    commands,
  };
}
