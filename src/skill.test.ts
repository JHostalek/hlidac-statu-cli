import { describe, expect, test } from 'bun:test';
import classifications from '../skills/hlidac-statu/references/endpoint-classification.json' with { type: 'json' };
import spec from './openapi.json' with { type: 'json' };

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function specOperations(): string[] {
  const operations: string[] = [];
  for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
    const path = rawPath.replace(/^\/api\/v2/, '') || '/';
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase())) operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations.sort();
}

describe('Hlídač státu skill', () => {
  test('classifies every OpenAPI operation exactly once', () => {
    const classified = classifications.flatMap((entry) => entry.operations);
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.sort()).toEqual(specOperations());
  });

  test('uses known exposure and effect classifications', () => {
    expect(new Set(classifications.map((entry) => entry.exposure))).toEqual(
      new Set(['default', 'conditional', 'avoid']),
    );
    expect(new Set(classifications.map((entry) => entry.effect))).toEqual(new Set(['read', 'write', 'mixed']));
  });
});
