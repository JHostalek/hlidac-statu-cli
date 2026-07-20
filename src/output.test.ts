import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunContext } from '@effect/platform-bun';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import type { BinaryResult, DryRunResult, JsonResult, TextResult } from './api.js';
import { missingCredentials, transportFailure } from './errors.js';
import { type CliFileOutput, formatEnvelope, formatFailure, formatOutcome, writeAtomically } from './output.js';

const base = (over: Partial<JsonResult>): JsonResult => ({
  _tag: 'JsonResult',
  method: 'GET',
  url: 'https://api.hlidacstatu.cz/api/v2/x',
  status: 200,
  contentType: 'application/json',
  headers: {},
  body: null,
  raw: '',
  ...over,
});

const text = (value: string, over: Partial<TextResult> = {}): TextResult => ({
  _tag: 'TextResult',
  method: 'GET',
  url: 'https://api.hlidacstatu.cz/api/v2/x',
  status: 200,
  contentType: 'text/plain',
  headers: {},
  text: value,
  ...over,
});

const binary = (chunks: readonly Uint8Array[], over: Partial<BinaryResult> = {}): BinaryResult => ({
  _tag: 'BinaryResult',
  method: 'GET',
  url: 'https://api.hlidacstatu.cz/api/v2/x',
  status: 200,
  contentType: 'application/zip',
  headers: {},
  stream: Stream.fromIterable(chunks),
  timeoutMs: 30_000,
  deadlineNanos: 9_000_000_000_000_000_000n,
  ...over,
});

const dryRun = (over: Partial<DryRunResult> = {}): DryRunResult => ({
  _tag: 'DryRunResult',
  method: 'GET',
  url: 'https://api.hlidacstatu.cz/api/v2/x',
  status: 0,
  contentType: '',
  headers: {},
  request: {
    contentType: null,
    body: null,
    authentication: { required: true, scheme: 'Token <redacted>' },
  },
  ...over,
});

async function fileBytes(file: CliFileOutput | undefined): Promise<Uint8Array> {
  if (!file) throw new Error('expected file output');
  const values = await Effect.runPromise(
    file.content.pipe(Stream.runFold([] as number[], (bytes, chunk) => [...bytes, ...chunk])),
  );
  return Uint8Array.from(values);
}

describe('formatOutcome', () => {
  test('renders JSON and HTTP failures for stdout', () => {
    const success = formatOutcome(base({ status: 200, body: { ok: true }, raw: '{"ok":true}' }));
    expect(success).toMatchObject({ exitCode: 0, stdout: '{\n  "ok": true\n}' });
    expect(success.stderr).toBeUndefined();

    const failure = formatOutcome(
      base({ status: 403, body: { message: 'forbidden' }, raw: '{"message":"forbidden"}' }),
    );
    expect(failure).toMatchObject({ exitCode: 1, stderr: 'HTTP 403' });
    expect(failure.stdout).toContain('forbidden');
  });

  test('preserves non-JSON text', () => {
    const outcome = formatOutcome(text('<html>Bad Gateway</html>', { status: 502, contentType: 'text/html' }));
    expect(outcome).toMatchObject({ exitCode: 1, stdout: '<html>Bad Gateway</html>' });
  });

  test('binary without -o fails without consuming the stream', () => {
    let consumed = false;
    const result = binary([], {
      stream: Stream.fromEffect(
        Effect.sync(() => {
          consumed = true;
          return new Uint8Array([1]);
        }),
      ),
    });
    const outcome = formatOutcome(result);
    expect(outcome).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'binary response (application/zip); use -o <path> to save',
    });
    expect(outcome.file).toBeUndefined();
    expect(consumed).toBe(false);
    expect(formatOutcome({ ...result, status: 500 }).stderr).toBe(
      'binary response (application/zip); use -o <path> to save',
    );
  });

  test('binary with -o routes the original stream silently and preserves HTTP failure status', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const success = formatOutcome(binary([bytes]), { output: '/tmp/out.zip' });
    expect(success).toMatchObject({ exitCode: 0, stdout: '', file: { path: '/tmp/out.zip' } });
    expect(success.stderr).toBeUndefined();
    expect(await fileBytes(success.file)).toEqual(bytes);

    const failure = formatOutcome(
      binary([new Uint8Array([0])], { status: 500, contentType: 'application/octet-stream' }),
      { output: '/tmp/err.bin' },
    );
    expect(failure).toMatchObject({ exitCode: 1, stderr: 'HTTP 500' });
  });

  test('text -o contains the exact stdout representation including newline and has no success chatter', async () => {
    const outcome = formatOutcome(base({ status: 200, body: { ok: true }, raw: '{"ok":true}' }), {
      output: '/tmp/out.json',
    });
    expect(outcome).toMatchObject({ exitCode: 0, stdout: '', file: { path: '/tmp/out.json' } });
    expect(outcome.stderr).toBeUndefined();
    expect(new TextDecoder().decode(await fileBytes(outcome.file))).toBe('{\n  "ok": true\n}\n');
  });
});

describe('formatEnvelope', () => {
  test('wraps success and HTTP failure bodies', async () => {
    const success = await Effect.runPromise(
      formatEnvelope(base({ status: 200, body: { hits: 1 }, raw: '{"hits":1}' })),
    );
    expect(JSON.parse(success.stdout)).toEqual({
      request: { method: 'GET', url: 'https://api.hlidacstatu.cz/api/v2/x' },
      status: 200,
      ok: true,
      body: { hits: 1 },
    });

    const failure = await Effect.runPromise(
      formatEnvelope(base({ status: 404, body: { error: 'not found' }, raw: '{"error":"not found"}' })),
    );
    expect(JSON.parse(failure.stdout)).toMatchObject({
      status: 404,
      ok: false,
      body: { error: 'not found' },
      error: { code: 'HTTP_FAILURE', retryable: false, details: { method: 'GET', status: 404 } },
    });
  });

  test('renders dry-run and empty response contracts', async () => {
    const outcome = await Effect.runPromise(
      formatEnvelope(dryRun({ url: 'https://api.hlidacstatu.cz/api/v2/smlouvy/hledat?dotaz=x' }), {
        dryRun: true,
      }),
    );
    expect(JSON.parse(outcome.stdout)).toMatchObject({ dryRun: true, ok: true, body: null });
    expect(JSON.parse(outcome.stdout).request.url).toContain('?dotaz=x');

    const empty = await Effect.runPromise(formatEnvelope(text('')));
    expect(JSON.parse(empty.stdout).body).toBeNull();
  });

  test('drains binary chunks and counts actual bytes without embedding them', async () => {
    const outcome = await Effect.runPromise(
      formatEnvelope(binary([new Uint8Array([0x50, 0x4b]), new Uint8Array([0x03, 0x04, 0xff])])),
    );
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      contentType: 'application/zip',
      bodyBytes: 5,
      body: null,
    });
  });

  test('-o routes the envelope representation silently instead of binary bytes', async () => {
    const outcome = await Effect.runPromise(
      formatEnvelope(binary([new Uint8Array([0x50, 0x4b])]), { output: '/tmp/env.json' }),
    );
    expect(outcome).toMatchObject({ exitCode: 0, stdout: '', file: { path: '/tmp/env.json' } });
    expect(outcome.stderr).toBeUndefined();
    const decoded = new TextDecoder().decode(await fileBytes(outcome.file));
    expect(decoded.endsWith('\n')).toBe(true);
    expect(JSON.parse(decoded)).toMatchObject({ bodyBytes: 2, body: null });
  });

  test('every buffered -o mode matches its selected stdout bytes exactly', async () => {
    const json = base({ body: { ok: true }, raw: '{"ok":true}' });
    const dry = dryRun();
    const failure = missingCredentials('GET', 'https://api.hlidacstatu.cz/api/v2/x');
    const request = failure.request ?? { method: '', url: '' };
    const pairs = [
      [formatOutcome(json), formatOutcome(json, { output: '/tmp/default.json' })],
      [
        await Effect.runPromise(formatEnvelope(json)),
        await Effect.runPromise(formatEnvelope(json, { output: '/tmp/envelope.json' })),
      ],
      [
        await Effect.runPromise(formatEnvelope(dry, { dryRun: true })),
        await Effect.runPromise(formatEnvelope(dry, { dryRun: true, output: '/tmp/dry-run.json' })),
      ],
      [formatFailure(failure, request), formatFailure(failure, request, { output: '/tmp/failure.json' })],
    ] as const;

    for (const [stdout, file] of pairs) {
      expect(file.stderr).toBeUndefined();
      expect(new TextDecoder().decode(await fileBytes(file.file))).toBe(`${stdout.stdout}\n`);
    }
  });
});

describe('writeAtomically', () => {
  test('keeps an existing destination visible until streaming completes, then replaces it and cleans temporary data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hs-output-'));
    const destination = join(directory, 'result.bin');
    writeFileSync(destination, 'original');
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const firstWritten = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const source = Stream.concat(
              Stream.succeed(new Uint8Array([1, 2])),
              Stream.fromEffect(
                Deferred.succeed(firstWritten, undefined).pipe(
                  Effect.zipRight(Deferred.await(release)),
                  Effect.as(new Uint8Array([3, 4])),
                ),
              ),
            );
            const fiber = yield* Effect.fork(writeAtomically(destination, source));
            yield* Deferred.await(firstWritten);
            yield* Effect.sync(() => {
              expect(readFileSync(destination, 'utf8')).toBe('original');
              expect(readdirSync(directory, { recursive: true }).length).toBeGreaterThan(1);
            });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(fiber);
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );

      expect(Array.from(readFileSync(destination))).toEqual([1, 2, 3, 4]);
      expect(readdirSync(directory)).toEqual(['result.bin']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('leaves the original destination untouched and cleans temporary data on stream failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hs-output-'));
    const destination = join(directory, 'result.bin');
    writeFileSync(destination, 'original');
    try {
      const failure = await Effect.runPromise(
        Effect.scoped(
          writeAtomically(
            destination,
            Stream.concat(
              Stream.succeed(new Uint8Array([1, 2])),
              Stream.fail(transportFailure('GET', 'https://example.test/binary')),
            ),
          ).pipe(Effect.flip),
        ).pipe(Effect.provide(BunContext.layer)),
      );
      expect(failure.code).toBe('TRANSPORT_FAILURE');
      expect(readFileSync(destination, 'utf8')).toBe('original');
      expect(readdirSync(directory)).toEqual(['result.bin']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cleans temporary data on interruption and maps publication failures to OUTPUT_FAILURE', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hs-output-'));
    const destination = join(directory, 'result.bin');
    writeFileSync(destination, 'original');
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const waiting = yield* Deferred.make<void>();
            const source = Stream.concat(
              Stream.succeed(new Uint8Array([1, 2])),
              Stream.fromEffect(Deferred.succeed(waiting, undefined).pipe(Effect.zipRight(Effect.never))),
            );
            const fiber = yield* Effect.fork(writeAtomically(destination, source));
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(fiber);
          }),
        ).pipe(Effect.provide(BunContext.layer)),
      );
      expect(readFileSync(destination, 'utf8')).toBe('original');
      expect(readdirSync(directory)).toEqual(['result.bin']);

      const failure = await Effect.runPromise(
        Effect.scoped(
          writeAtomically(join(directory, 'missing', 'result.bin'), Stream.succeed(new Uint8Array([1]))).pipe(
            Effect.flip,
          ),
        ).pipe(Effect.provide(BunContext.layer)),
      );
      expect(failure).toMatchObject({
        code: 'OUTPUT_FAILURE',
        details: { destination: join(directory, 'missing', 'result.bin') },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
