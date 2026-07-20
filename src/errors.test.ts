import { describe, expect, test } from 'bun:test';
import {
  binaryOutputRequired,
  exitCodeForFailure,
  httpFailure,
  internalFailure,
  missingCredentials,
  outputFailure,
  requestTimeout,
  schemaPathNotFound,
  transportFailure,
} from './errors.js';

describe('public failure policy', () => {
  test('maps configuration failures to exit 2 and operational failures to exit 1', () => {
    expect(exitCodeForFailure(missingCredentials('GET', 'https://example.test'))).toBe(2);
    expect(exitCodeForFailure(schemaPathNotFound(['unknown'], []))).toBe(2);
    expect(exitCodeForFailure(transportFailure('GET', 'https://example.test'))).toBe(1);
    expect(exitCodeForFailure(binaryOutputRequired('GET', 'https://example.test', 'application/zip'))).toBe(1);
    expect(exitCodeForFailure(outputFailure('/tmp/results.json'))).toBe(1);
    expect(exitCodeForFailure(internalFailure())).toBe(1);
  });

  test('marks only read-only transient failures retryable', () => {
    expect(requestTimeout('GET', 'https://example.test', 30_000).retryable).toBe(true);
    expect(requestTimeout('POST', 'https://example.test', 30_000).retryable).toBe(false);
    expect(httpFailure('GET', 'https://example.test', 503).retryable).toBe(true);
    expect(httpFailure('POST', 'https://example.test', 503).retryable).toBe(false);
    expect(httpFailure('GET', 'https://example.test', 404).retryable).toBe(false);
  });

  test('keeps URLs outside public error details and excludes underlying causes', () => {
    const failure = transportFailure('GET', 'https://example.test/x?token=secret');
    expect(failure).toMatchObject({
      code: 'TRANSPORT_FAILURE',
      details: { method: 'GET' },
      request: { method: 'GET', url: 'https://example.test/x?token=secret' },
    });
    expect(failure.details).not.toHaveProperty('url');
    expect(JSON.stringify(failure)).not.toContain('cause');
  });
});
