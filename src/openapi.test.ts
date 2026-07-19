import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { type OpenApiSpec, registerFromOpenApi } from './generator.js';
import spec from './openapi.json' with { type: 'json' };

describe('embedded OpenAPI contract', () => {
  test('registers every non-colliding operation from API 2.5.0.1', () => {
    const result = registerFromOpenApi(new Command(), spec as OpenApiSpec);

    expect(spec.openapi).toBe('3.0.4');
    expect(spec.info.title).toBe('HlidacStatu Api 2.5.0.1');
    expect(result.registered).toBe(62);
    expect(result.skipped).toEqual([
      {
        method: 'POST',
        path: '/api/v2/datasety/{datasetId}/zaznamy',
        reason: 'command name collision',
      },
    ]);
  });
});
