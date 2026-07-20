import { describe, expect, test } from 'bun:test';
import { type AddressInfo, createServer } from 'node:net';
import * as FetchHttpClient from '@effect/platform/FetchHttpClient';
import { ConfigProvider, Effect, Layer, Stream } from 'effect';
import { DEFAULT_TIMEOUT_MS, HlidacClientLive, type HlidacResult, hlidacRequest } from './api.js';
import { CliFailure } from './errors.js';

const ClientLayer = HlidacClientLive.pipe(Layer.provide(FetchHttpClient.layer));

function runRequest(
  request: Parameters<typeof hlidacRequest>,
  configuration: Record<string, string> = {},
): Promise<HlidacResult> {
  const provider = ConfigProvider.fromMap(new Map(Object.entries(configuration)));
  return Effect.runPromise(
    Effect.scoped(hlidacRequest(...request).pipe(Effect.provide(ClientLayer), Effect.withConfigProvider(provider))),
  );
}

describe('HlidacClientLive', () => {
  test('defaults request execution to 30 seconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  test('encodes request URL, repeated query, token header and JSON body through Effect HTTP', async () => {
    let captured: Request | undefined;
    const bodies: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        captured = request;
        bodies.push(await request.json());
        return Response.json({ received: bodies.at(-1) });
      },
    });
    try {
      const result = await runRequest(['post', '/x', { tag: ['one', 'two'], q: 'česká energie' }, { hello: 'world' }], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2/`,
        HLIDAC_STATU_API_TOKEN: 'test-token',
      });

      expect(result._tag).toBe('JsonResult');
      expect(captured?.method).toBe('POST');
      expect(captured?.headers.get('authorization')).toBe('Token test-token');
      expect(captured?.headers.get('content-type')).toBe('application/json');
      const url = new URL(captured?.url ?? '');
      expect(url.pathname).toBe('/api/v2/x');
      expect(url.searchParams.getAll('tag')).toEqual(['one', 'two']);
      expect(url.searchParams.get('q')).toBe('česká energie');

      await runRequest(['POST', '/x', undefined, 'hello'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2`,
      });
      expect(bodies).toEqual([{ hello: 'world' }, 'hello']);
    } finally {
      server.stop(true);
    }
  });

  test('loads credentials lazily and permits an unauthenticated explicit base override', async () => {
    let authorization: string | null = 'not-called';
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        return Response.json({ ok: true });
      },
    });
    try {
      const result = await runRequest(['GET', '/x'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}/api/v2`,
      });
      expect(result.status).toBe(200);
      expect(authorization).toBeNull();

      const dryRun = await runRequest(['POST', '/x', undefined, { secret: false }, { dryRun: true }]);
      expect(dryRun._tag).toBe('DryRunResult');
      if (dryRun._tag === 'DryRunResult') {
        expect(dryRun.request.authentication).toEqual({ required: true, scheme: 'Token <redacted>' });
      }
    } finally {
      server.stop(true);
    }
  });

  test('fails with a redacted stable missing-credential error only for live default-base requests', async () => {
    const captured = await Effect.runPromise(
      Effect.scoped(
        hlidacRequest('GET', '/x').pipe(
          Effect.flip,
          Effect.provide(ClientLayer),
          Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
        ),
      ),
    );
    expect(captured).toBeInstanceOf(CliFailure);
    expect(captured).toMatchObject({ code: 'MISSING_CREDENTIALS', retryable: false });
    expect(JSON.stringify(captured)).not.toContain('Authorization');
  });

  test('sanitizes invalid base URL configuration', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        hlidacRequest('GET', '/x').pipe(
          Effect.flip,
          Effect.provide(ClientLayer),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', 'https://user:secret@%invalid']])),
          ),
        ),
      ),
    );

    expect(failure).toMatchObject({
      code: 'INVALID_INPUT',
      retryable: false,
      details: { method: 'GET', variable: 'HLIDAC_STATU_BASE_URL' },
    });
    expect(JSON.stringify(failure)).not.toContain('secret');

    const userInfoFailure = await Effect.runPromise(
      Effect.scoped(
        hlidacRequest('GET', '/x', { q: 'private-value' }).pipe(
          Effect.flip,
          Effect.provide(ClientLayer),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', 'http://user:test-secret@127.0.0.1:9']])),
          ),
        ),
      ),
    );
    expect(userInfoFailure).toMatchObject({ code: 'INVALID_INPUT' });
    expect(JSON.stringify(userInfoFailure)).not.toContain('test-secret');
    expect(JSON.stringify(userInfoFailure)).not.toContain('private-value');

    for (const unsafeBase of [
      'http://127.0.0.1:9/api/v2?api_key=query-secret',
      'http://127.0.0.1:9/api/v2#fragment-secret',
      'file:///tmp/hlidac',
    ]) {
      const unsafeFailure = await Effect.runPromise(
        Effect.scoped(
          hlidacRequest('GET', '/x').pipe(
            Effect.flip,
            Effect.provide(ClientLayer),
            Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', unsafeBase]]))),
          ),
        ),
      );
      expect(unsafeFailure).toMatchObject({ code: 'INVALID_INPUT' });
      expect(JSON.stringify(unsafeFailure)).not.toContain('query-secret');
      expect(JSON.stringify(unsafeFailure)).not.toContain('fragment-secret');
    }
  });

  test('maps body encoding failures to invalid input before transport', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const failure = await Effect.runPromise(
      Effect.scoped(
        hlidacRequest('POST', '/x', undefined, cyclic).pipe(
          Effect.flip,
          Effect.provide(ClientLayer),
          Effect.withConfigProvider(ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', 'http://127.0.0.1:9']]))),
        ),
      ),
    );

    expect(failure).toMatchObject({ code: 'INVALID_INPUT', retryable: false });
  });

  test('rejects invalid timeout values at the client boundary', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failure = await Effect.runPromise(
        Effect.scoped(
          hlidacRequest('GET', '/x', undefined, undefined, { timeoutMs }).pipe(
            Effect.flip,
            Effect.provide(ClientLayer),
            Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
          ),
        ),
      );
      expect(failure).toMatchObject({
        code: 'INVALID_INPUT',
        details: { parameter: 'timeout' },
      });
    }
  });

  test('keeps status responses as values and distinguishes JSON, text and binary bodies', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/json')) return Response.json({ reason: 'busy' }, { status: 503 });
        if (path.endsWith('/invalid-json')) {
          return new Response('{broken', { headers: { 'Content-Type': 'application/problem+json' } });
        }
        if (path.endsWith('/empty')) {
          return new Response('', { headers: { 'Content-Type': 'application/json' } });
        }
        if (path.endsWith('/text')) return new Response('hello', { headers: { 'Content-Type': 'text/plain' } });
        return new Response(new Uint8Array([0x50, 0x4b]).buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'application/zip' },
        });
      },
    });
    const config = { HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${server.port}` };
    try {
      const [json, invalidJson, empty, text] = await Promise.all([
        runRequest(['GET', '/json'], config),
        runRequest(['GET', '/invalid-json'], config),
        runRequest(['GET', '/empty'], config),
        runRequest(['GET', '/text'], config),
      ]);
      const binary = await Effect.runPromise(
        Effect.scoped(
          hlidacRequest('GET', '/binary').pipe(
            Effect.flatMap((result) =>
              result._tag === 'BinaryResult'
                ? result.stream.pipe(
                    Stream.runFold([] as number[], (bytes, chunk) => [...bytes, ...chunk]),
                    Effect.map((bytes) => ({ result, bytes })),
                  )
                : Effect.die('expected binary response'),
            ),
            Effect.provide(ClientLayer),
            Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(config)))),
          ),
        ),
      );
      expect(json).toMatchObject({ _tag: 'JsonResult', status: 503, body: { reason: 'busy' } });
      expect(invalidJson).toMatchObject({ _tag: 'TextResult', text: '{broken' });
      expect(empty).toMatchObject({ _tag: 'TextResult', text: '' });
      expect(text).toMatchObject({ _tag: 'TextResult', text: 'hello' });
      expect(binary.result._tag).toBe('BinaryResult');
      expect(binary.bytes).toEqual([0x50, 0x4b]);
    } finally {
      server.stop(true);
    }
  });

  test('maps total timeout and transport failures without exposing causes', async () => {
    const delayed = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(200);
        return Response.json({ late: true });
      },
    });
    const unavailable = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    const unavailablePort = unavailable.port;
    unavailable.stop(true);
    try {
      const [timeout, transport] = await Promise.all([
        Effect.runPromise(
          Effect.scoped(
            hlidacRequest('GET', '/x', undefined, undefined, { timeoutMs: 20 }).pipe(
              Effect.flip,
              Effect.provide(ClientLayer),
              Effect.withConfigProvider(
                ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', `http://127.0.0.1:${delayed.port}`]])),
              ),
            ),
          ),
        ),
        Effect.runPromise(
          Effect.scoped(
            hlidacRequest('POST', '/x', undefined, undefined, { timeoutMs: 200 }).pipe(
              Effect.flip,
              Effect.provide(ClientLayer),
              Effect.withConfigProvider(
                ConfigProvider.fromMap(new Map([['HLIDAC_STATU_BASE_URL', `http://127.0.0.1:${unavailablePort}`]])),
              ),
            ),
          ),
        ),
      ]);

      expect(timeout).toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true });
      expect(transport).toMatchObject({ code: 'TRANSPORT_FAILURE', retryable: false });
      expect(JSON.stringify([timeout, transport])).not.toContain('cause');
    } finally {
      delayed.stop(true);
    }
  });

  test('missing Content-Type on HTTP error preserves the textual error', async () => {
    const message = 'Překročen maximální počet API requestů.';
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runRequest(['GET', '/firmy/ico/24738123'], {
        HLIDAC_STATU_BASE_URL: `http://127.0.0.1:${port}`,
      });
      expect(result).toMatchObject({ _tag: 'TextResult', status: 429, contentType: '', text: message });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
