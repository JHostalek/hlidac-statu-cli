import * as FileSystem from '@effect/platform/FileSystem';
import * as Path from '@effect/platform/Path';
import { Clock, Duration, Effect, type Scope, Sink, Stream } from 'effect';
import type { HlidacResult } from './api.js';
import {
  binaryOutputRequired,
  type CliFailure,
  exitCodeForFailure,
  httpFailure,
  outputFailure,
  requestTimeout,
} from './errors.js';

type ByteStream = Stream.Stream<Uint8Array, CliFailure>;

interface FileTimeout {
  readonly deadlineNanos: bigint;
  readonly failure: CliFailure;
}

export interface CliFileOutput {
  readonly path: string;
  readonly content: ByteStream;
  readonly timeout?: FileTimeout;
}

export interface CliOutcome {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly file?: CliFileOutput;
  readonly failureStyle?: 'plain' | 'structured';
  readonly request?: { readonly method: string; readonly url: string };
}

export interface OutcomeOptions {
  readonly output?: string;
}

const encoder = new TextEncoder();

function selectedTextBytes(text: string): Uint8Array {
  return encoder.encode(text.length > 0 ? `${text}\n` : '');
}

function selectedTextStream(text: string): ByteStream {
  return Stream.succeed(selectedTextBytes(text));
}

export function formatOutcome(result: HlidacResult, options: OutcomeOptions = {}): CliOutcome {
  const { output } = options;
  const request = { method: result.method, url: result.url };

  if (result._tag === 'BinaryResult') {
    if (output === undefined) {
      const failure = binaryOutputRequired(result.method, result.url, result.contentType);
      return {
        stdout: '',
        stderr: failure.message,
        exitCode: exitCodeForFailure(failure),
        failureStyle: 'plain',
        request,
      };
    }
    return {
      stdout: '',
      stderr: result.status >= 400 ? `HTTP ${result.status}` : undefined,
      exitCode: result.status >= 400 ? 1 : 0,
      file: {
        path: output,
        content: result.stream,
        timeout: {
          deadlineNanos: result.deadlineNanos,
          failure: requestTimeout(result.method, result.url, result.timeoutMs),
        },
      },
      failureStyle: 'plain',
      request,
    };
  }

  const stdout =
    result._tag === 'JsonResult'
      ? JSON.stringify(result.body, null, 2)
      : result._tag === 'TextResult'
        ? result.text
        : '';
  const exitCode = result.status >= 400 ? 1 : 0;
  const stderr = result.status >= 400 ? `HTTP ${result.status}` : undefined;

  if (output !== undefined) {
    return {
      stdout: '',
      stderr,
      exitCode,
      file: { path: output, content: selectedTextStream(stdout) },
      failureStyle: 'plain',
      request,
    };
  }

  return { stdout, stderr, exitCode, failureStyle: 'plain', request };
}

export interface EnvelopeOptions extends OutcomeOptions {
  readonly dryRun?: boolean;
}

function envelopeOutcome(result: HlidacResult, bodyBytes: number | undefined, options: EnvelopeOptions): CliOutcome {
  const { dryRun = false, output } = options;
  const ok = dryRun || (result.status >= 200 && result.status < 400);
  const request = { method: result.method, url: result.url };
  const envelope: Record<string, unknown> = {
    request: {
      ...request,
      ...(result._tag === 'DryRunResult' ? result.request : {}),
    },
    status: result.status,
    ok,
  };
  if (result._tag === 'BinaryResult') {
    envelope.contentType = result.contentType;
    envelope.bodyBytes = bodyBytes ?? 0;
    envelope.body = null;
  } else if (result._tag === 'JsonResult') {
    envelope.body = result.body;
  } else if (result._tag === 'TextResult') {
    envelope.body = result.text.length > 0 ? result.text : null;
  } else {
    envelope.body = null;
  }
  if (dryRun) envelope.dryRun = true;
  if (!dryRun && result.status >= 400) {
    const failure = httpFailure(result.method, result.url, result.status);
    envelope.error = {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      details: failure.details,
    };
  }

  const stdout = JSON.stringify(envelope, null, 2);
  const exitCode = ok ? 0 : 1;
  if (output !== undefined) {
    return {
      stdout: '',
      exitCode,
      file: { path: output, content: selectedTextStream(stdout) },
      failureStyle: 'structured',
      request,
    };
  }
  return { stdout, exitCode, failureStyle: 'structured', request };
}

export function formatEnvelope(
  result: HlidacResult,
  options: EnvelopeOptions = {},
): Effect.Effect<CliOutcome, CliFailure> {
  if (result._tag !== 'BinaryResult') return Effect.succeed(envelopeOutcome(result, undefined, options));
  return withDeadline(
    result.stream.pipe(Stream.runFold(0, (total, chunk) => total + chunk.byteLength)),
    result.deadlineNanos,
    requestTimeout(result.method, result.url, result.timeoutMs),
  ).pipe(Effect.map((bodyBytes) => envelopeOutcome(result, bodyBytes, options)));
}

function withDeadline<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadlineNanos: bigint,
  failure: CliFailure,
): Effect.Effect<A, E | CliFailure, R> {
  return Clock.currentTimeNanos.pipe(
    Effect.flatMap((now) =>
      now >= deadlineNanos
        ? Effect.fail(failure)
        : effect.pipe(
            Effect.timeoutFail({
              duration: Duration.nanos(deadlineNanos - now),
              onTimeout: () => failure,
            }),
          ),
    ),
  );
}

export function formatFailure(
  failure: CliFailure,
  request: { readonly method: string; readonly url: string },
  options: OutcomeOptions = {},
): CliOutcome {
  const envelope = JSON.stringify(
    {
      request,
      status: null,
      ok: false,
      body: null,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        details: failure.details,
      },
    },
    null,
    2,
  );
  const exitCode = exitCodeForFailure(failure);
  if (options.output) {
    return {
      stdout: '',
      exitCode,
      file: { path: options.output, content: selectedTextStream(envelope) },
      failureStyle: 'structured',
      request,
    };
  }
  return { stdout: envelope, exitCode, failureStyle: 'structured', request };
}

export function writeAtomically(
  destination: string,
  content: ByteStream,
): Effect.Effect<void, CliFailure, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs
      .makeTempFileScoped({
        directory: path.dirname(destination),
        prefix: `.${path.basename(destination)}-`,
      })
      .pipe(Effect.mapError(() => outputFailure(destination)));
    const sink = fs.sink(temporary).pipe(Sink.mapError(() => outputFailure(destination)));
    yield* content.pipe(Stream.run(sink));
    yield* fs.rename(temporary, destination).pipe(Effect.mapError(() => outputFailure(destination)));
  });
}

export class CliExit {
  readonly _tag = 'CliExit';

  constructor(readonly code: number) {}
}

function emitConsole(outcome: CliOutcome): Effect.Effect<void, CliExit> {
  const write = (stream: NodeJS.WriteStream, text: string | undefined) =>
    text
      ? Effect.async<void>((resume) => {
          stream.write(`${text}\n`, () => resume(Effect.void));
        })
      : Effect.void;
  return write(process.stdout, outcome.stdout).pipe(
    Effect.zipRight(write(process.stderr, outcome.stderr)),
    Effect.zipRight(outcome.exitCode === 0 ? Effect.void : Effect.fail(new CliExit(outcome.exitCode))),
  );
}

function emissionFailureOutcome(failure: CliFailure, original: CliOutcome): CliOutcome {
  if (original.failureStyle === 'structured') {
    return formatFailure(failure, failure.request ?? original.request ?? { method: '', url: '' });
  }
  return {
    stdout: '',
    stderr: failure.message,
    exitCode: exitCodeForFailure(failure),
    failureStyle: 'plain',
    request: failure.request ?? original.request,
  };
}

export function emitOutcome(outcome: CliOutcome): Effect.Effect<void, CliExit, FileSystem.FileSystem | Path.Path> {
  if (!outcome.file) return emitConsole(outcome);
  const write = Effect.scoped(writeAtomically(outcome.file.path, outcome.file.content));
  const timedWrite = outcome.file.timeout
    ? withDeadline(write, outcome.file.timeout.deadlineNanos, outcome.file.timeout.failure)
    : write;
  return timedWrite.pipe(
    Effect.matchEffect({
      onFailure: (failure) => emitConsole(emissionFailureOutcome(failure, outcome)),
      onSuccess: () => emitConsole({ ...outcome, file: undefined }),
    }),
  );
}
