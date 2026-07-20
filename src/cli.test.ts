import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandPlan, type JsonSchema, type OpenApiSpec, planCommands } from './generator.js';
import spec from './openapi.json' with { type: 'json' };

const cliPath = new URL('./cli.ts', import.meta.url).pathname;
const cleanCwd = mkdtempSync(join(tmpdir(), 'hs-cli-test-'));

afterAll(() => rmSync(cleanCwd, { recursive: true }));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const { HLIDAC_STATU_API_TOKEN: _token, HLIDAC_STATU_BASE_URL: _baseUrl, ...cleanEnv } = process.env;
  const child = Bun.spawn([Bun.which('bun') ?? 'bun', cliPath, ...args], {
    cwd: cleanCwd,
    env: { ...cleanEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function optionValue(schema: JsonSchema | undefined): string {
  if (typeof schema !== 'object' || schema === null) return 'value';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return String(schema.enum[0]);
  if (schema.type === 'integer' || schema.type === 'number') return '1';
  if (schema.type === 'boolean') return 'true';
  return 'value';
}

function dryRunArgs(plan: CommandPlan): { args: string[]; expectedPath: string } {
  const args = ['--dry-run', ...plan.tree];
  let expectedPath = plan.path;
  for (const [index, parameter] of plan.pathParams.entries()) {
    const schema = typeof parameter.schema === 'object' && parameter.schema !== null ? parameter.schema : undefined;
    const value =
      schema?.type === 'integer' || schema?.type === 'number' || schema?.type === 'boolean'
        ? optionValue(parameter.schema)
        : `value ${index + 1}`;
    args.push(value);
    expectedPath = expectedPath.replace(`{${parameter.name}}`, encodeURIComponent(value));
  }
  for (const parameter of plan.queryParams.filter((candidate) => candidate.required)) {
    args.push(`--${parameter.name}`, optionValue(parameter.schema));
  }
  if (plan.requestBody?.required) args.push('--data', '{}');
  return { args, expectedPath };
}

describe('Effect CLI command surface', () => {
  test('every planned OpenAPI operation is executable from its schema path', async () => {
    const plans = planCommands(spec as OpenApiSpec).filter((plan) => plan.registration === 'generated');

    for (let index = 0; index < plans.length; index += 8) {
      const batch = plans.slice(index, index + 8);
      const results = await Promise.all(
        batch.map(async (plan) => {
          const { args, expectedPath } = dryRunArgs(plan);
          const result = await runCli(args);
          const envelope = result.stdout.length > 0 ? JSON.parse(result.stdout) : undefined;
          return { plan, expectedPath, result, envelope };
        }),
      );

      for (const { plan, expectedPath, result, envelope } of results) {
        expect(
          {
            exitCode: result.exitCode,
            stderr: result.stderr,
            method: envelope?.request?.method,
            pathname: envelope ? new URL(envelope.request.url).pathname : undefined,
          },
          plan.tree.join(' '),
        ).toEqual({ exitCode: 0, stderr: '', method: plan.method, pathname: `/api/v2${expectedPath}` });
      }
    }
  }, 30_000);

  test('uses native global options and exact command matching without autocorrection', async () => {
    const [prefix, commandNamedOutput, suffix, wrongCase, typo] = await Promise.all([
      runCli(['--dry-run', 'smlouvy', 'hledat']),
      runCli(['--output', 'schema', '--dry-run', 'smlouvy', 'hledat']),
      runCli(['smlouvy', 'hledat', '--dry-run']),
      runCli(['--dry-run', 'Smlouvy', 'hledat']),
      runCli(['--dry-run', 'smlouvi', 'hledat']),
    ]);

    expect(prefix.exitCode).toBe(0);
    expect(commandNamedOutput.exitCode).toBe(0);
    expect(suffix.exitCode).toBe(2);
    for (const rejected of [wrongCase, typo]) {
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr.toLowerCase()).not.toContain('did you mean');
    }
  });

  test('rejects a missing global option value before execution', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return Response.json({ ok: true });
      },
    });
    try {
      const result = await runCli(['--output', '--dry-run', 'smlouvy', 'hledat'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2`,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('missing value for global option --output');
      expect(requests).toBe(0);
      expect(existsSync(join(cleanCwd, '--dry-run'))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('validates required arguments, numeric options, and enums before execution', async () => {
    const [missing, invalidNumber, invalidEnum, validEnum] = await Promise.all([
      runCli(['--dry-run', 'smlouvy', 'get']),
      runCli(['--dry-run', 'aitask', 'GetTasks', '--maxItems', 'nope']),
      runCli(['--dry-run', 'aitask', 'GetTasks', '--status', '4']),
      runCli(['--dry-run', 'aitask', 'GetTasks', '--status', '-1']),
    ]);

    expect(missing.exitCode).toBe(2);
    expect(invalidNumber.exitCode).toBe(2);
    expect(invalidEnum.exitCode).toBe(2);
    expect(validEnum.exitCode).toBe(0);
    expect(new URL(JSON.parse(validEnum.stdout).request.url).searchParams.get('status')).toBe('-1');
  });

  test('supports bare and explicit booleans and applies OpenAPI defaults', async () => {
    const [omitted, bare, explicitFalse, defaultTrue, repeatedArray] = await Promise.all([
      runCli(['--dry-run', 'osoby', 'hledat']),
      runCli(['--dry-run', 'osoby', 'hledat', '--ignoreDiakritiku']),
      runCli(['--dry-run', 'osoby', 'hledat', '--ignoreDiakritiku', 'false']),
      runCli(['--dry-run', 'tbls', 'AddTask']),
      runCli(['--dry-run', 'verejnezakazky', 'hledat', '--cpv', '45000000', '--cpv', '71000000']),
    ]);

    expect([
      omitted.exitCode,
      bare.exitCode,
      explicitFalse.exitCode,
      defaultTrue.exitCode,
      repeatedArray.exitCode,
    ]).toEqual([0, 0, 0, 0, 0]);
    expect(new URL(JSON.parse(omitted.stdout).request.url).searchParams.get('ignoreDiakritiku')).toBe('false');
    expect(new URL(JSON.parse(bare.stdout).request.url).searchParams.get('ignoreDiakritiku')).toBe('true');
    expect(new URL(JSON.parse(explicitFalse.stdout).request.url).searchParams.get('ignoreDiakritiku')).toBe('false');
    expect(new URL(JSON.parse(defaultTrue.stdout).request.url).searchParams.get('force')).toBe('true');
    expect(new URL(JSON.parse(repeatedArray.stdout).request.url).searchParams.getAll('cpv')).toEqual([
      '45000000',
      '71000000',
    ]);
  });

  test('validates JSON and exposes the complete redacted dry-run request', async () => {
    const [generated, malformed, raw, invalidPair, emptyKey, invalidMethod] = await Promise.all([
      runCli(['--dry-run', 'datasety', 'zaznamy', 'post', 'set', '--data', '{"x":1}']),
      runCli(['--dry-run', 'datasety', 'zaznamy', 'post', 'set', '--data', '{']),
      runCli(['--dry-run', 'raw', 'POST', '/x', 'a=b', '--data', '{"x":1}']),
      runCli(['--dry-run', 'raw', 'GET', '/x', 'invalid']),
      runCli(['--dry-run', 'raw', 'GET', '/x', '=value']),
      runCli(['--dry-run', 'raw', 'CONNECT', '/x']),
    ]);

    expect(generated.exitCode).toBe(0);
    expect(JSON.parse(generated.stdout).request).toEqual({
      method: 'POST',
      url: 'https://api.hlidacstatu.cz/api/v2/datasety/set/zaznamy',
      contentType: 'application/json',
      body: { x: 1 },
      authentication: { required: true, scheme: 'Token <redacted>' },
    });
    expect(raw.exitCode).toBe(0);
    expect(JSON.parse(raw.stdout).request).toEqual({
      method: 'POST',
      url: 'https://api.hlidacstatu.cz/api/v2/x?a=b',
      contentType: 'application/json',
      body: { x: 1 },
      authentication: { required: true, scheme: 'Token <redacted>' },
    });
    for (const rejected of [malformed, invalidPair, emptyKey, invalidMethod]) expect(rejected.exitCode).toBe(2);
  });

  test('keeps standard Effect CLI built-ins operational without credentials', async () => {
    const [help, configuredHelp, combinedHelp, groupHelp, leafHelp, version, completions, logLevel] = await Promise.all(
      [
        runCli(['--help']),
        runCli(['--log-level', 'none', '--help']),
        runCli(['--help', '--json']),
        runCli(['smlouvy', '--help']),
        runCli(['smlouvy', 'hledat', '--help']),
        runCli(['--version']),
        runCli(['--completions', 'zsh']),
        runCli(['--log-level', 'none', '--dry-run', 'smlouvy', 'hledat']),
      ],
    );

    expect([
      help.exitCode,
      configuredHelp.exitCode,
      combinedHelp.exitCode,
      groupHelp.exitCode,
      leafHelp.exitCode,
      version.exitCode,
      completions.exitCode,
      logLevel.exitCode,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(help.stdout).toContain('--wizard');
    expect(help.stdout).toContain('--completions');
    expect(help.stdout).toContain('datasety');
    expect(help.stdout).not.toContain('datasety datasety');
    expect(help.stdout).not.toContain('aitask aitask');
    expect(configuredHelp.stdout).not.toContain('datasety datasety');
    expect(combinedHelp.stdout).not.toContain('datasety datasety');
    expect(groupHelp.stdout).toContain('hledat');
    expect(leafHelp.stdout).toContain('--dotaz');
    expect(version.stdout.trim()).toBe('0.2.0');
    expect(completions.stdout).toContain('#compdef hs');
  });

  test('executes a generated live request through the single application runner', async () => {
    let receivedUrl = '';
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        receivedUrl = request.url;
        return Response.json({ ok: true });
      },
    });
    try {
      const result = await runCli(['smlouvy', 'hledat', '--dotaz', 'česká energie'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2`,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr, body: JSON.parse(result.stdout) }).toEqual({
        exitCode: 0,
        stderr: '',
        body: { ok: true },
      });
      expect(new URL(receivedUrl).searchParams.get('dotaz')).toBe('česká energie');
    } finally {
      server.stop(true);
    }
  });

  test('maps a missing live credential through the application lifecycle without an Effect defect report', async () => {
    const result = await runCli(['smlouvy', 'hledat']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('HLIDAC_STATU_API_TOKEN is not set');
    expect(result.stderr).not.toContain('FiberFailure');
  });
});
