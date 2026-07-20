import { Args, Command, HelpDoc, Options } from '@effect/cli';
import { Effect, Option } from 'effect';
import { HlidacStatuError, hlidacRequest, type QueryValue } from './api.js';
import { handleRaw, RAW_METHODS } from './commands/raw.js';
import { buildSchemaDocument, filterSchemaDocument, SchemaPathNotFoundError } from './commands/schema.js';
import { type CommandPlan, cleanHelp, type JsonSchema, type Parameter } from './generator.js';
import { type CliExit, type CliOutcome, emitOutcome, formatEnvelope, formatOutcome } from './output.js';

interface GlobalOptions {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly output: Option.Option<string>;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime-generated OpenAPI trees require one erased heterogeneous command type.
type AnyCommand = Command.Command<string, any, any, any>;
type HsCommand = Command.Command<string, never, CliExit, unknown>;

interface CommandNode {
  readonly name: string;
  plan?: CommandPlan;
  readonly children: Map<string, CommandNode>;
}

function schemaRecord(schema: JsonSchema | undefined): Record<string, unknown> | undefined {
  return typeof schema === 'object' && schema !== null ? schema : undefined;
}

function parameterDescription(parameter: Parameter): string {
  const facets: string[] = [];
  const schema = schemaRecord(parameter.schema);
  if (typeof schema?.type === 'string') facets.push(schema.type);
  if (parameter.required) facets.push('required');
  if (schema?.default !== undefined) facets.push(`default ${String(schema.default)}`);
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) facets.push(`enum: ${schema.enum.join('|')}`);
  const description = cleanHelp(parameter.description);
  return [facets.length > 0 ? `(${facets.join(', ')})` : '', description].filter(Boolean).join(' ');
}

function scalarOption(name: string, schema: Record<string, unknown> | undefined): Options.Options<unknown> {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    return Options.choiceWithValue(
      name,
      schema.enum.map((value) => [String(value), value] as const),
    );
  }
  if (schema?.type === 'integer') return Options.integer(name);
  if (schema?.type === 'number') return Options.float(name);
  if (schema?.type === 'boolean') return Options.boolean(name);
  return Options.text(name);
}

function coerceDefault(value: unknown, type: unknown): unknown {
  if (type === 'string') return String(value);
  if (type === 'integer' || type === 'number') return Number(value);
  if (type === 'boolean') return Boolean(value);
  return value;
}

export function optionFor(parameter: Parameter, argv: readonly string[]): Options.Options<unknown> {
  const schema = schemaRecord(parameter.schema);
  let option: Options.Options<unknown>;
  if (schema?.type === 'array') {
    const itemSchema = schemaRecord(schema.items as JsonSchema | undefined);
    const item = scalarOption(parameter.name, itemSchema);
    if (parameter.required) {
      option = Options.atLeast(item, 1);
    } else {
      const repeated = Options.repeated(item);
      option =
        schema.default === undefined
          ? repeated
          : Options.map(repeated, (values) => (values.length === 0 ? schema.default : values));
    }
  } else {
    option = scalarOption(parameter.name, schema);
    if (schema?.type === 'boolean' && parameter.required) {
      option = Options.mapTryCatch(
        option,
        (value) => {
          if (!optionWasSpecified(parameter.name, argv)) {
            throw new CliUsageError(`missing required option --${parameter.name}`);
          }
          return value;
        },
        (error) => HelpDoc.p(error instanceof Error ? error.message : String(error)),
      );
    } else if (schema?.type !== 'boolean') {
      if (schema?.default !== undefined)
        option = Options.withDefault(option, coerceDefault(schema.default, schema.type));
      else if (!parameter.required) option = Options.optional(option);
    }
  }
  const description = parameterDescription(parameter);
  return description.length > 0 ? Options.withDescription(option, description) : option;
}

function scalarArgument(parameter: Parameter): Args.Args<unknown> {
  const schema = schemaRecord(parameter.schema);
  let argument: Args.Args<unknown>;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    argument = Args.choice(
      schema.enum.map((value) => [String(value), value] as const),
      { name: parameter.name },
    );
  } else if (schema?.type === 'integer') argument = Args.integer({ name: parameter.name });
  else if (schema?.type === 'number') argument = Args.float({ name: parameter.name });
  else if (schema?.type === 'boolean') argument = Args.boolean({ name: parameter.name });
  else argument = Args.text({ name: parameter.name });
  const description = parameterDescription(parameter);
  return description.length > 0 ? Args.withDescription(argument, description) : argument;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function jsonOption(required: boolean): Options.Options<unknown> {
  const option = Options.text('data').pipe(
    Options.withAlias('d'),
    Options.withDescription('JSON request body (parsed before send)'),
    Options.mapTryCatch(parseJson, (error) =>
      HelpDoc.p(`invalid --data JSON: ${error instanceof Error ? error.message : String(error)}`),
    ),
  );
  return required ? option : Options.optional(option);
}

function optionValue(value: unknown): unknown {
  return Option.isOption(value) ? Option.getOrUndefined(value) : value;
}

function outputPath(globals: GlobalOptions): string | undefined {
  return Option.getOrUndefined(globals.output);
}

function optionWasSpecified(name: string, argv: readonly string[]): boolean {
  const flag = `--${name}`;
  return argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}

export class CliUsageError extends Error {
  readonly exitCode = 2;
}

export function resolveQueryParameters(
  plan: Pick<CommandPlan, 'queryParams'>,
  values: Record<string, unknown>,
  argv: readonly string[],
): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const [index, parameter] of plan.queryParams.entries()) {
    const schema = schemaRecord(parameter.schema);
    const specified = optionWasSpecified(parameter.name, argv);
    let value = optionValue(values[`query${index}`]);
    if (schema?.type === 'boolean' && !specified) {
      if (parameter.required) throw new CliUsageError(`missing required option --${parameter.name}`);
      value = schema.default !== undefined ? coerceDefault(schema.default, 'boolean') : undefined;
    }
    if (Array.isArray(value) && value.length === 0) value = undefined;
    if (value !== undefined) query[parameter.name] = value as QueryValue;
  }
  return query;
}

function failureOutcome(error: unknown): CliOutcome {
  if (error instanceof HlidacStatuError) return { stdout: '', stderr: error.message, exitCode: error.exitCode };
  if (error instanceof CliUsageError) return { stdout: '', stderr: error.message, exitCode: error.exitCode };
  return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

function runOutcome(effect: Effect.Effect<CliOutcome, unknown>): Effect.Effect<void, CliExit> {
  return effect.pipe(
    Effect.catchAll((error) => Effect.succeed(failureOutcome(error))),
    Effect.flatMap(emitOutcome),
  );
}

function requestOutcome(
  plan: CommandPlan,
  values: Record<string, unknown>,
  globals: GlobalOptions,
  argv: readonly string[],
): Effect.Effect<void, CliExit> {
  let resolvedPath = plan.path;
  for (const [index, parameter] of plan.pathParams.entries()) {
    resolvedPath = resolvedPath.replace(`{${parameter.name}}`, encodeURIComponent(String(values[`path${index}`])));
  }

  let query: Record<string, QueryValue>;
  try {
    query = resolveQueryParameters(plan, values, argv);
  } catch (error) {
    return emitOutcome(failureOutcome(error));
  }

  const body = plan.hasRequestBody ? optionValue(values.data) : undefined;
  const dryRun = globals.dryRun;
  const output = outputPath(globals);
  return runOutcome(
    Effect.tryPromise({
      try: () => hlidacRequest(plan.method, resolvedPath, query, body, { dryRun }),
      catch: (error) => error,
    }).pipe(
      Effect.map((result) =>
        globals.json || dryRun ? formatEnvelope(result, { dryRun, output }) : formatOutcome(result, { output }),
      ),
    ),
  );
}

function generatedCommand(
  name: string,
  plan: CommandPlan,
  root: Command.Command<'hs', never, never, GlobalOptions>,
  argv: readonly string[],
): AnyCommand {
  const config: Record<string, Args.Args<unknown> | Options.Options<unknown>> = {};
  for (const [index, parameter] of plan.pathParams.entries()) config[`path${index}`] = scalarArgument(parameter);
  for (const [index, parameter] of plan.queryParams.entries()) config[`query${index}`] = optionFor(parameter, argv);
  if (plan.hasRequestBody) config.data = jsonOption(plan.requestBody?.required === true);

  return Command.make(name, config, (parsed) =>
    root.pipe(Effect.flatMap((globals) => requestOutcome(plan, parsed as Record<string, unknown>, globals, argv))),
  ).pipe(Command.withDescription(cleanHelp(plan.summary) || `${plan.method} ${plan.path}`)) as AnyCommand;
}

function commandTree(plans: CommandPlan[]): CommandNode[] {
  const roots = new Map<string, CommandNode>();
  for (const plan of plans) {
    if (plan.registration !== 'generated') continue;
    let children = roots;
    let node: CommandNode | undefined;
    for (const name of plan.tree) {
      node = children.get(name);
      if (!node) {
        node = { name, children: new Map() };
        children.set(name, node);
      }
      children = node.children;
    }
    if (node) node.plan = plan;
  }
  return [...roots.values()];
}

function materializeNode(
  node: CommandNode,
  root: Command.Command<'hs', never, never, GlobalOptions>,
  argv: readonly string[],
): AnyCommand {
  let command: AnyCommand = node.plan
    ? generatedCommand(node.name, node.plan, root, argv)
    : (Command.make(node.name) as unknown as AnyCommand);
  const children = [...node.children.values()].map((child) => materializeNode(child, root, argv));
  if (children.length > 0) {
    command = Command.withSubcommands(command, children as [AnyCommand, ...AnyCommand[]]) as AnyCommand;
  }
  return command;
}

function rawCommand(root: Command.Command<'hs', never, never, GlobalOptions>): AnyCommand {
  const method = Args.choice(
    RAW_METHODS.map((value) => [value, value] as const),
    { name: 'method' },
  ).pipe(Args.withDescription('HTTP method'));
  const path = Args.text({ name: 'path' }).pipe(Args.withDescription('API path under /api/v2'));
  const params = Args.text({ name: 'key=value' }).pipe(
    Args.repeated,
    Args.mapTryCatch(
      (values) => {
        const invalid = values.find((value) => value.indexOf('=') <= 0);
        if (invalid) throw new Error(`invalid key=value argument: ${invalid}`);
        return values;
      },
      (error) => HelpDoc.p(error instanceof Error ? error.message : String(error)),
    ),
  );
  const data = jsonOption(false);
  return Command.make('raw', { method, path, params, data }, ({ method, path, params, data }) =>
    root.pipe(
      Effect.flatMap((globals) =>
        runOutcome(
          Effect.tryPromise({
            try: () =>
              handleRaw(method, path, params, optionValue(data), {
                json: globals.json,
                dryRun: globals.dryRun,
                output: outputPath(globals),
              }),
            catch: (error) => error,
          }),
        ),
      ),
    ),
  ).pipe(
    Command.withDescription(
      'Hit any Hlídač státu endpoint directly. Example: hs raw GET /smlouvy/hledat dotaz=elektřiny',
    ),
  ) as AnyCommand;
}

function schemaCommand(plans: CommandPlan[], version: string): AnyCommand {
  const path = Args.text({ name: 'path' }).pipe(Args.repeated, Args.withDescription('command group or leaf path'));
  return Command.make('schema', { path }, ({ path }) => {
    try {
      const document = filterSchemaDocument(buildSchemaDocument(plans, version), path);
      return emitOutcome({ stdout: JSON.stringify(document, null, 2), exitCode: 0 });
    } catch (error) {
      if (!(error instanceof SchemaPathNotFoundError)) return emitOutcome(failureOutcome(error));
      return emitOutcome({
        stdout: JSON.stringify(
          {
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
          },
          null,
          2,
        ),
        exitCode: error.exitCode,
      });
    }
  }).pipe(Command.withDescription('Print the machine-readable command tree as JSON')) as AnyCommand;
}

function makeRootCommand(): Command.Command<'hs', never, never, GlobalOptions> {
  const json = Options.boolean('json').pipe(
    Options.withDescription('emit a JSON envelope { request, status, ok, body, error? } to stdout'),
  );
  const dryRun = Options.boolean('dry-run').pipe(
    Options.withDescription('resolve the request but do not call the API; implies --json'),
  );
  const output = Options.text('output').pipe(
    Options.withAlias('o'),
    Options.withDescription('write the selected response representation to a file'),
    Options.optional,
  );
  const root = Command.make('hs', { json, dryRun, output }).pipe(
    Command.withDescription('CLI wrapper for the Hlídač státu REST API v2'),
  );
  return root;
}

export function makeRootHelpCommand(plans: CommandPlan[]): HsCommand {
  const root = makeRootCommand();
  const descriptions = new Map<string, string>();
  for (const plan of plans) {
    const name = plan.tree[0];
    if (!name || descriptions.has(name)) continue;
    descriptions.set(name, plan.tree.length === 1 && plan.summary ? cleanHelp(plan.summary) : `${name} commands`);
  }
  descriptions.set('raw', 'Hit any Hlídač státu endpoint directly');
  descriptions.set('schema', 'Print the machine-readable command tree as JSON');
  const subcommands = [...descriptions]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, description]) => Command.make(name).pipe(Command.withDescription(description)) as AnyCommand);
  return Command.withSubcommands(root, subcommands as [AnyCommand, ...AnyCommand[]]) as unknown as HsCommand;
}

export function makeCliCommand(plans: CommandPlan[], version: string, argv: readonly string[]): HsCommand {
  const root = makeRootCommand();
  const subcommands = [
    ...commandTree(plans).map((node) => [node.name, materializeNode(node, root, argv)] as const),
    ['raw', rawCommand(root)] as const,
    ['schema', schemaCommand(plans, version)] as const,
  ]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, command]) => command);
  return Command.withSubcommands(root, subcommands as [AnyCommand, ...AnyCommand[]]) as unknown as HsCommand;
}
