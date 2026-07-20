import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function spawnCli(args: string[], env: Record<string, string> = {}) {
  const { HLIDAC_STATU_API_TOKEN: _token, HLIDAC_STATU_BASE_URL: _baseUrl, ...cleanEnv } = process.env;
  return Bun.spawn([Bun.which('bun') ?? 'bun', cliPath, ...args], {
    cwd: cleanCwd,
    env: { ...cleanEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function collectCli(child: ReturnType<typeof spawnCli>): Promise<CliResult> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return collectCli(spawnCli(args, env));
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

  test('requires positive explicit-unit timeout values', async () => {
    const [unitless, zero, negative, valid] = await Promise.all([
      runCli(['--timeout', '30', '--dry-run', 'smlouvy', 'hledat']),
      runCli(['--timeout', '0s', '--dry-run', 'smlouvy', 'hledat']),
      runCli(['--timeout=-1s', '--dry-run', 'smlouvy', 'hledat']),
      runCli(['--timeout', '250ms', '--dry-run', 'smlouvy', 'hledat']),
    ]);

    expect([unitless.exitCode, zero.exitCode, negative.exitCode, valid.exitCode]).toEqual([2, 2, 2, 0]);
    expect(unitless.stderr).toContain('explicit unit');
  });

  test('renders timeout failures with a stable sanitized envelope', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(200);
        return Response.json({ tooLate: true });
      },
    });
    try {
      const result = await runCli(['--json', '--timeout', '20ms', 'smlouvy', 'hledat'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({
        status: null,
        ok: false,
        body: null,
        error: {
          code: 'REQUEST_TIMEOUT',
          retryable: true,
          details: { method: 'GET', timeoutMs: 20 },
        },
      });
      expect(JSON.stringify(envelope)).not.toContain('HLIDAC_STATU_API_TOKEN');
    } finally {
      server.stop(true);
    }
  });

  test('keeps HTTP failures as responses and computes retryability from method and status', async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return Response.json({ reason: 'busy' }, { status: 503 });
      },
    });
    const env = { HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2` };
    try {
      const [read, write] = await Promise.all([
        runCli(['--json', 'smlouvy', 'hledat'], env),
        runCli(['--json', 'datasety', 'post', '--data', '{}'], env),
      ]);

      expect([read.exitCode, write.exitCode, calls]).toEqual([1, 1, 2]);
      expect(read.stderr).toBe('');
      expect(write.stderr).toBe('');
      expect(JSON.parse(read.stdout)).toMatchObject({
        status: 503,
        body: { reason: 'busy' },
        error: { code: 'HTTP_FAILURE', retryable: true, details: { status: 503, method: 'GET' } },
      });
      expect(JSON.parse(write.stdout)).toMatchObject({
        status: 503,
        body: { reason: 'busy' },
        error: { code: 'HTTP_FAILURE', retryable: false, details: { status: 503, method: 'POST' } },
      });
    } finally {
      server.stop(true);
    }
  });

  test('renders missing credentials and transport failures as stable structured results', async () => {
    const unavailable = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    const unavailablePort = unavailable.port;
    unavailable.stop(true);

    const [missing, transport] = await Promise.all([
      runCli(['--json', 'smlouvy', 'hledat']),
      runCli(['--json', '--timeout', '200ms', 'smlouvy', 'hledat'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${unavailablePort}/api/v2`,
      }),
    ]);

    expect([missing.exitCode, transport.exitCode]).toEqual([2, 1]);
    expect([missing.stderr, transport.stderr]).toEqual(['', '']);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: null,
      ok: false,
      error: { code: 'MISSING_CREDENTIALS', retryable: false },
    });
    expect(JSON.parse(transport.stdout)).toMatchObject({
      status: null,
      ok: false,
      error: { code: 'TRANSPORT_FAILURE', retryable: true },
    });
    expect(`${missing.stdout}${transport.stdout}`).not.toContain('Authorization');

    const unsafeBase = await runCli(['--json', 'smlouvy', 'hledat', '--dotaz', 'private-value'], {
      HLIDAC_STATU_BASE_URL: 'http://user:test-secret@127.0.0.1:9/api/v2',
    });
    expect(unsafeBase.exitCode).toBe(2);
    expect(JSON.parse(unsafeBase.stdout)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(`${unsafeBase.stdout}${unsafeBase.stderr}`).not.toContain('test-secret');
    expect(`${unsafeBase.stdout}${unsafeBase.stderr}`).not.toContain('private-value');
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

  test('streams binary output, drains structured output, and cancels an unused body', async () => {
    const directory = mkdtempSync(join(cleanCwd, 'binary-'));
    const rawDestination = join(directory, 'download.bin');
    const envelopeDestination = join(directory, 'envelope.json');
    const slowDestination = join(directory, 'slow.bin');
    const controlledDestination = join(directory, 'controlled.bin');
    let cancelled = false;
    let releaseControlled = () => {};
    const controlledRelease = new Promise<void>((resolve) => {
      releaseControlled = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/never')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'Content-Type': 'application/octet-stream' } },
          );
        }
        if (path.endsWith('/slow')) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                timer = setTimeout(() => {
                  controller.enqueue(new Uint8Array([3, 4, 5]));
                  controller.close();
                }, 200);
              },
              cancel() {
                if (timer) clearTimeout(timer);
              },
            }),
            { headers: { 'Content-Type': 'application/octet-stream' } },
          );
        }
        if (path.endsWith('/combined')) {
          await Bun.sleep(70);
          let timer: ReturnType<typeof setTimeout> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                timer = setTimeout(() => {
                  controller.enqueue(new Uint8Array([3, 4, 5]));
                  controller.close();
                }, 70);
              },
              cancel() {
                if (timer) clearTimeout(timer);
              },
            }),
            { headers: { 'Content-Type': 'application/octet-stream' } },
          );
        }
        if (path.endsWith('/controlled')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                void controlledRelease.then(() => {
                  controller.enqueue(new Uint8Array([3, 4, 5]));
                  controller.close();
                });
              },
            }),
            { headers: { 'Content-Type': 'application/octet-stream' } },
          );
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            setTimeout(() => {
              controller.enqueue(new Uint8Array([3, 4, 5]));
              controller.close();
            }, 20);
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream' } });
      },
    });
    const env = { HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2` };
    try {
      writeFileSync(rawDestination, 'original');
      const raw = await runCli(['--output', rawDestination, 'raw', 'GET', '/binary'], env);
      expect(raw).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(Array.from(readFileSync(rawDestination))).toEqual([1, 2, 3, 4, 5]);

      writeFileSync(controlledDestination, 'original');
      const controlledChild = spawnCli(['--output', controlledDestination, 'raw', 'GET', '/controlled'], env);
      let streamedPrefix: number[] | undefined;
      for (let attempt = 0; attempt < 100 && !streamedPrefix; attempt++) {
        for (const entry of readdirSync(directory, { recursive: true }).map(String)) {
          const candidate = join(directory, entry);
          if (entry.includes('.controlled.bin-') && statSync(candidate).isFile()) {
            const bytes = readFileSync(candidate);
            if (bytes.byteLength > 0) streamedPrefix = Array.from(bytes);
          }
        }
        if (!streamedPrefix) await Bun.sleep(5);
      }
      expect(readFileSync(controlledDestination, 'utf8')).toBe('original');
      releaseControlled();
      expect(await collectCli(controlledChild)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(streamedPrefix).toEqual([1, 2]);
      expect(Array.from(readFileSync(controlledDestination))).toEqual([1, 2, 3, 4, 5]);

      const structured = await runCli(['--json', 'raw', 'GET', '/binary'], env);
      expect(structured.exitCode).toBe(0);
      expect(structured.stderr).toBe('');
      expect(JSON.parse(structured.stdout)).toMatchObject({
        body: null,
        bodyBytes: 5,
        contentType: 'application/octet-stream',
      });

      const structuredFile = await runCli(['--json', '--output', envelopeDestination, 'raw', 'GET', '/binary'], env);
      expect(structuredFile).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(JSON.parse(readFileSync(envelopeDestination, 'utf8'))).toMatchObject({ body: null, bodyBytes: 5 });

      writeFileSync(slowDestination, 'original');
      const timed = await runCli(['--timeout', '20ms', '--output', slowDestination, 'raw', 'GET', '/slow'], env);
      expect(timed).toMatchObject({ exitCode: 1, stdout: '' });
      expect(timed.stderr).toContain('request timed out after 20ms');
      expect(readFileSync(slowDestination, 'utf8')).toBe('original');

      const [combinedFile, combinedStructured] = await Promise.all([
        runCli(['--timeout', '100ms', '--output', slowDestination, 'raw', 'GET', '/combined'], env),
        runCli(['--json', '--timeout', '100ms', 'raw', 'GET', '/combined'], env),
      ]);
      expect(combinedFile.exitCode).toBe(1);
      expect(combinedFile.stderr).toContain('request timed out after 100ms');
      expect(readFileSync(slowDestination, 'utf8')).toBe('original');
      expect(JSON.parse(combinedStructured.stdout)).toMatchObject({
        error: { code: 'REQUEST_TIMEOUT', details: { timeoutMs: 100 } },
      });

      const rejected = await runCli(['raw', 'GET', '/never'], env);
      expect(rejected).toMatchObject({ exitCode: 1, stdout: '' });
      expect(rejected.stderr).toContain('use -o <path> to save');
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) await Bun.sleep(5);
      expect(cancelled).toBe(true);
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('-o writes the exact selected text representation silently and reports output failures structurally', async () => {
    const directory = mkdtempSync(join(cleanCwd, 'text-output-'));
    const destination = join(directory, 'result.json');
    const missingDestination = join(directory, 'missing', 'result.json');
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    const env = { HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2` };
    try {
      const stdout = await runCli(['raw', 'GET', '/json'], env);
      const file = await runCli(['--output', destination, 'raw', 'GET', '/json'], env);
      expect(file).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(readFileSync(destination, 'utf8')).toBe(stdout.stdout);

      const failure = await runCli(['--json', '--output', missingDestination, 'raw', 'GET', '/json'], env);
      expect(failure.exitCode).toBe(1);
      expect(failure.stderr).toBe('');
      expect(JSON.parse(failure.stdout)).toMatchObject({
        error: { code: 'OUTPUT_FAILURE', retryable: false, details: { destination: missingDestination } },
      });
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
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
