import * as HttpClient from '@effect/platform/HttpClient';
import * as HttpClientRequest from '@effect/platform/HttpClientRequest';
import type { HttpClientResponse } from '@effect/platform/HttpClientResponse';
import type { HttpMethod } from '@effect/platform/HttpMethod';
import { Clock, Config, Context, Duration, Effect, Layer, Option, Redacted, type Scope, Stream } from 'effect';
import { CliFailure, invalidInput, missingCredentials, requestTimeout, transportFailure } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.hlidacstatu.cz/api/v2';
export const DEFAULT_TIMEOUT_MS = 30_000;

interface ResultBase {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface JsonResult extends ResultBase {
  readonly _tag: 'JsonResult';
  readonly body: unknown;
  readonly raw: string;
}

export interface TextResult extends ResultBase {
  readonly _tag: 'TextResult';
  readonly text: string;
}

export interface BinaryResult extends ResultBase {
  readonly _tag: 'BinaryResult';
  readonly stream: Stream.Stream<Uint8Array, CliFailure>;
  readonly timeoutMs: number;
  readonly deadlineNanos: bigint;
}

export interface DryRunResult extends ResultBase {
  readonly _tag: 'DryRunResult';
  readonly request: {
    readonly contentType: string | null;
    readonly body: unknown;
    readonly authentication: { readonly required: boolean; readonly scheme: 'Token <redacted>' };
  };
}

export type HlidacResult = JsonResult | TextResult | BinaryResult | DryRunResult;
export type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

export interface HlidacRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly dryRun?: boolean;
  readonly timeoutMs?: number;
}

export interface HlidacClientService {
  readonly execute: (request: HlidacRequest) => Effect.Effect<HlidacResult, CliFailure, Scope.Scope>;
}

export class HlidacClient extends Context.Tag('HlidacClient')<HlidacClient, HlidacClientService>() {}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const base = new URL(baseUrl);
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0
  ) {
    throw new Error('base URL must be an HTTP(S) origin and path without credentials, query, or fragment');
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(base.toString().replace(/\/+$/, '') + normalizedPath);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export function isTextual(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return (
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized.startsWith('text/') ||
    normalized === 'application/x-www-form-urlencoded'
  );
}

function responseResult(
  response: HttpClientResponse,
  method: string,
  url: string,
  timeoutMs: number,
  deadlineNanos: bigint,
): Effect.Effect<HlidacResult, unknown> {
  const contentType = response.headers['content-type'] ?? '';
  const base = { method, url, status: response.status, contentType, headers: response.headers };
  if (method === 'HEAD' || response.status === 204 || response.status === 205 || response.status === 304) {
    return Effect.succeed({ _tag: 'TextResult', ...base, text: '' });
  }
  const decodeText = response.text.pipe(
    Effect.map((text): JsonResult | TextResult => {
      if (text.length === 0) return { _tag: 'TextResult', ...base, text };
      try {
        const body = JSON.parse(text);
        return { _tag: 'JsonResult', ...base, body, raw: text };
      } catch {
        return { _tag: 'TextResult', ...base, text };
      }
    }),
  );
  // IIS can omit Content-Type on textual HTTP errors, notably rate limits.
  if (response.status >= 400 && contentType.trim() === '') return decodeText;
  if (!isTextual(contentType)) {
    return Effect.succeed({
      _tag: 'BinaryResult' as const,
      ...base,
      stream: response.stream.pipe(Stream.mapError(() => transportFailure(method, url))),
      timeoutMs,
      deadlineNanos,
    });
  }
  return decodeText;
}

function liveClient(httpClient: HttpClient.HttpClient): HlidacClientService {
  const scopedHttpClient = HttpClient.withScope(httpClient);
  return {
    execute: (input) =>
      Effect.gen(function* () {
        const method = input.method.toUpperCase();
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return yield* invalidInput('timeout must be a positive finite duration', { parameter: 'timeout' });
        }
        const baseOverride = yield* Config.option(Config.nonEmptyString('HLIDAC_STATU_BASE_URL'));
        const baseUrl = Option.getOrElse(baseOverride, () => DEFAULT_BASE_URL);
        const url = yield* Effect.try({
          try: () => buildUrl(baseUrl, input.path, input.query),
          catch: () => invalidInput('invalid request URL', { method, variable: 'HLIDAC_STATU_BASE_URL' }),
        });

        if (input.dryRun) {
          return {
            _tag: 'DryRunResult' as const,
            method,
            url,
            status: 0,
            contentType: '',
            headers: {},
            request: {
              contentType: input.body === undefined ? null : 'application/json',
              body: input.body ?? null,
              authentication: {
                required: Option.isNone(baseOverride),
                scheme: 'Token <redacted>' as const,
              },
            },
          };
        }

        const token = yield* Config.option(Config.redacted(Config.nonEmptyString('HLIDAC_STATU_API_TOKEN')));
        if (Option.isNone(token) && Option.isNone(baseOverride)) return yield* missingCredentials(method, url);

        let request = HttpClientRequest.make(method as HttpMethod)(url);
        if (Option.isSome(token)) {
          request = HttpClientRequest.setHeader(request, 'Authorization', `Token ${Redacted.value(token.value)}`);
        }
        if (input.body !== undefined) {
          request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
            Effect.mapError(() => invalidInput('request body is not JSON-serializable', { method }, { method, url })),
          );
        }

        const requestStartedAt = yield* Clock.currentTimeNanos;
        const deadlineNanos = requestStartedAt + BigInt(Math.ceil(timeoutMs * 1_000_000));
        return yield* scopedHttpClient.execute(request).pipe(
          Effect.flatMap((response) => responseResult(response, method, url, timeoutMs, deadlineNanos)),
          Effect.mapError(() => transportFailure(method, url)),
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () => requestTimeout(method, url, timeoutMs),
          }),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CliFailure ? error : invalidInput('invalid Hlídač configuration'),
        ),
      ),
  };
}

export const HlidacClientLive = Layer.effect(
  HlidacClient,
  Effect.map(HttpClient.HttpClient, (httpClient) => liveClient(httpClient)),
);

export function hlidacRequest(
  method: string,
  path: string,
  query?: Record<string, QueryValue>,
  body?: unknown,
  options: { readonly dryRun?: boolean; readonly timeoutMs?: number } = {},
): Effect.Effect<HlidacResult, CliFailure, HlidacClient | Scope.Scope> {
  return Effect.flatMap(HlidacClient, (client) =>
    client.execute({ method, path, query, body, dryRun: options.dryRun, timeoutMs: options.timeoutMs }),
  );
}
