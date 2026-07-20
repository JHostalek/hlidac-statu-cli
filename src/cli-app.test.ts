import { describe, expect, test } from 'bun:test';
import { CliConfig, Options, ValidationError } from '@effect/cli';
import { BunContext } from '@effect/platform-bun';
import { Cause, Effect, Exit, Option } from 'effect';
import { CliUsageError, optionFor, resolveQueryParameters } from './cli-app.js';
import type { Parameter } from './generator.js';

function booleanParameter(required: boolean, defaultValue?: boolean): Parameter {
  return {
    name: 'enabled',
    in: 'query',
    required,
    schema: { type: 'boolean', ...(defaultValue === undefined ? {} : { default: defaultValue }) },
  };
}

function arrayParameter(defaultValue?: string[]): Parameter {
  return {
    name: 'tag',
    in: 'query',
    schema: {
      type: 'array',
      items: { type: 'string' },
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
    },
  };
}

describe('resolveQueryParameters', () => {
  test('rejects an omitted required boolean', () => {
    expect(() =>
      resolveQueryParameters({ queryParams: [booleanParameter(true)] }, { query0: false }, ['hs', 'x']),
    ).toThrow(CliUsageError);
  });

  test('preserves an explicitly false required boolean', () => {
    expect(
      resolveQueryParameters({ queryParams: [booleanParameter(true)] }, { query0: false }, [
        'hs',
        '--enabled=false',
        'x',
      ]),
    ).toEqual({ enabled: false });
  });

  test('applies an optional boolean default only when omitted', () => {
    expect(
      resolveQueryParameters({ queryParams: [booleanParameter(false, true)] }, { query0: false }, ['hs', 'x']),
    ).toEqual({ enabled: true });
  });
});

describe('required boolean parser option', () => {
  test('fails in Effect CLI parsing when omitted', async () => {
    const option = optionFor(booleanParameter(true), []);
    const exit = await Effect.runPromiseExit(
      Options.processCommandLine(option, [], CliConfig.defaultConfig).pipe(Effect.provide(BunContext.layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && ValidationError.isValidationError(failure.value)).toBe(true);
    }
  });

  test('parses explicit false', async () => {
    const args = ['--enabled=false'];
    const option = optionFor(booleanParameter(true), args);
    const exit = await Effect.runPromiseExit(
      Options.processCommandLine(option, args, CliConfig.defaultConfig).pipe(Effect.provide(BunContext.layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value[2]).toBe(false);
  });
});

describe('array parser option', () => {
  test('applies an optional array default when omitted', async () => {
    const option = optionFor(arrayParameter(['default']), []);
    const result = await Effect.runPromise(
      Options.processCommandLine(option, [], CliConfig.defaultConfig).pipe(Effect.provide(BunContext.layer)),
    );

    expect(result[2]).toEqual(['default']);
  });

  test('preserves repeated explicit values instead of the default', async () => {
    const args = ['--tag', 'one', '--tag', 'two'];
    const option = optionFor(arrayParameter(['default']), args);
    const result = await Effect.runPromise(
      Options.processCommandLine(option, args, CliConfig.defaultConfig).pipe(Effect.provide(BunContext.layer)),
    );

    expect(result[2]).toEqual(['one', 'two']);
  });
});
