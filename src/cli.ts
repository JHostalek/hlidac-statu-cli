#!/usr/bin/env bun
import { CliConfig, Command, ValidationError } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Cause, Effect, Exit, Option } from 'effect';
import packageJson from '../package.json' with { type: 'json' };
import { makeCliCommand, makeRootHelpCommand } from './cli-app.js';
import { type OpenApiSpec, planCommands } from './generator.js';
import spec from './openapi.json' with { type: 'json' };
import { CliExit } from './output.js';

const plans = planCommands(spec as OpenApiSpec);
const args = process.argv.slice(2);
const topLevelCommands = new Set([...plans.map((plan) => plan.tree[0]), 'raw', 'schema']);
const globalOptions = new Set(['--json', '--dry-run', '--output', '-o']);
const valueOptions = new Set(['--output', '-o', '--completions', '--log-level']);
const booleanOptions = new Set(['--json', '--dry-run', '--help', '-h', '--wizard', '--version']);
const booleanValues = new Set(['true', 'false', '1', '0', 'y', 'yes', 'n', 'no', 'on', 'off']);
const missingGlobalValue = args.find((argument, index) => {
  const [name, attachedValue] = argument.split('=', 2);
  return (
    valueOptions.has(name) &&
    (attachedValue === '' || (attachedValue === undefined && (!args[index + 1] || args[index + 1]?.startsWith('-'))))
  );
});

function nextRootArgument(index: number): number | undefined {
  const argument = args[index];
  if (!argument) return undefined;
  const [name, attachedValue] = argument.split('=', 2);
  if (valueOptions.has(name)) {
    return attachedValue === undefined && !args[index + 1]?.startsWith('-') ? index + 2 : index + 1;
  }
  if (booleanOptions.has(name)) {
    return attachedValue === undefined && booleanValues.has(args[index + 1] ?? '') ? index + 2 : index + 1;
  }
  return undefined;
}

let commandIndex: number | undefined;
let prefixEnd = 0;
while (prefixEnd < args.length) {
  const next = nextRootArgument(prefixEnd);
  if (next !== undefined) {
    prefixEnd = next;
    continue;
  }
  if (topLevelCommands.has(args[prefixEnd])) commandIndex = prefixEnd;
  break;
}
const requestedHelp = args.some((argument) => {
  const name = argument.split('=', 1)[0];
  return name === '--help' || name === '-h';
});
const rootHelp = args.length === 0 || (commandIndex === undefined && prefixEnd >= args.length && requestedHelp);
const normalizedArgs = args.flatMap((argument, index) => {
  const previousIsOutput = index > 0 && (args[index - 1] === '--output' || args[index - 1] === '-o');
  if (previousIsOutput && !argument.startsWith('-')) return [];
  if (index >= (commandIndex ?? args.length) || (argument !== '--output' && argument !== '-o')) return [argument];
  if (args[index + 1]?.startsWith('-') ?? true) return [argument];
  return [`--output=${args[index + 1] ?? ''}`];
});
const runnerArgv = [...process.argv.slice(0, 2), ...normalizedArgs];
const command = rootHelp ? makeRootHelpCommand(plans) : makeCliCommand(plans, packageJson.version, runnerArgv);
const misplacedGlobal =
  commandIndex === undefined
    ? undefined
    : args.slice(commandIndex + 1).find((argument) => globalOptions.has(argument.split('=', 1)[0] ?? argument));
const runCommand = Command.run(command, {
  name: 'hs',
  version: packageJson.version,
  executable: 'hs',
})(runnerArgv);
const argvError = missingGlobalValue
  ? `missing value for global option ${missingGlobalValue}`
  : misplacedGlobal
    ? `global option ${misplacedGlobal} must precede the command path`
    : undefined;
const placementCheck = argvError
  ? Effect.sync(() => process.stderr.write(`${argvError}\n`)).pipe(Effect.zipRight(Effect.fail(new CliExit(2))))
  : Effect.void;
const program = placementCheck.pipe(
  Effect.zipRight(runCommand),
  Effect.provide(CliConfig.layer({ isCaseSensitive: true, autoCorrectLimit: 0 })),
  Effect.provide(BunContext.layer),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
  disablePrettyLogger: true,
  teardown(exit, onExit) {
    if (Exit.isSuccess(exit)) return onExit(0);
    const failure = Cause.failureOption(exit.cause);
    if (Option.isNone(failure)) return onExit(1);
    if (failure.value instanceof CliExit) return onExit(failure.value.code);
    return onExit(ValidationError.isValidationError(failure.value) ? 2 : 1);
  },
});
