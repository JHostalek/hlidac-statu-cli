import { Data } from 'effect';

export type PublicErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_CREDENTIALS'
  | 'REQUEST_TIMEOUT'
  | 'TRANSPORT_FAILURE'
  | 'HTTP_FAILURE'
  | 'BINARY_OUTPUT_REQUIRED'
  | 'OUTPUT_FAILURE'
  | 'SCHEMA_PATH_NOT_FOUND'
  | 'INTERNAL_FAILURE';

export type ErrorDetail = string | number | boolean | null | readonly string[] | readonly (readonly string[])[];

export type ErrorDetails = Readonly<Record<string, ErrorDetail>>;

export interface FailureRequest {
  readonly method: string;
  readonly url: string;
}

export class CliFailure extends Data.TaggedError('CliFailure')<{
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: ErrorDetails;
  readonly request?: FailureRequest;
}> {}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}

export function invalidInput(message: string, details: ErrorDetails = {}, request?: FailureRequest): CliFailure {
  return new CliFailure({ code: 'INVALID_INPUT', message, retryable: false, details, request });
}

export function missingCredentials(method: string, url: string): CliFailure {
  return new CliFailure({
    code: 'MISSING_CREDENTIALS',
    message:
      'HLIDAC_STATU_API_TOKEN is not set. Get a token at https://www.hlidacstatu.cz/api and export it:\n  export HLIDAC_STATU_API_TOKEN=<your-token>',
    retryable: false,
    details: { method, variable: 'HLIDAC_STATU_API_TOKEN' },
    request: { method, url },
  });
}

export function requestTimeout(method: string, url: string, timeoutMs: number): CliFailure {
  return new CliFailure({
    code: 'REQUEST_TIMEOUT',
    message: `request timed out after ${timeoutMs}ms`,
    retryable: isReadOnlyMethod(method),
    details: { method, timeoutMs },
    request: { method, url },
  });
}

export function transportFailure(method: string, url: string): CliFailure {
  return new CliFailure({
    code: 'TRANSPORT_FAILURE',
    message: 'request transport failed',
    retryable: isReadOnlyMethod(method),
    details: { method },
    request: { method, url },
  });
}

export function httpFailure(method: string, url: string, status: number): CliFailure {
  return new CliFailure({
    code: 'HTTP_FAILURE',
    message: `HTTP ${status}`,
    retryable: isReadOnlyMethod(method) && TRANSIENT_HTTP_STATUSES.has(status),
    details: { method, status },
    request: { method, url },
  });
}

export function schemaPathNotFound(path: readonly string[], suggestions: readonly (readonly string[])[]): CliFailure {
  return new CliFailure({
    code: 'SCHEMA_PATH_NOT_FOUND',
    message: `unknown schema path: ${path.join(' ')}`,
    retryable: false,
    details: { path, suggestions },
  });
}

export function internalFailure(): CliFailure {
  return new CliFailure({
    code: 'INTERNAL_FAILURE',
    message: 'unexpected internal failure',
    retryable: false,
    details: {},
  });
}

export function exitCodeForFailure(failure: CliFailure): 1 | 2 {
  return failure.code === 'INVALID_INPUT' ||
    failure.code === 'MISSING_CREDENTIALS' ||
    failure.code === 'SCHEMA_PATH_NOT_FOUND'
    ? 2
    : 1;
}
