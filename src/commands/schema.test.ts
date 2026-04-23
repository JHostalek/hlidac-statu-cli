import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerFromOpenApi } from '../generator.js';
import { collectSchema } from './schema.js';

describe('collectSchema', () => {
  test('emits one entry per leaf with full param metadata', () => {
    const program = new Command();
    registerFromOpenApi(program, {
      paths: {
        '/api/v2/smlouvy/hledat': {
          get: {
            summary: 'Search contracts',
            parameters: [
              { name: 'dotaz', in: 'query', description: 'fulltext', schema: { type: 'string' } },
              { name: 'strana', in: 'query', schema: { type: 'integer', default: 1 } },
              {
                name: 'razeni',
                in: 'query',
                schema: { type: 'integer', enum: [0, 1, 2, 3] },
              },
            ],
          },
        },
        '/api/v2/smlouvy/{id}': {
          get: {
            summary: 'Get contract',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      },
    });

    const entries = collectSchema(program);
    expect(entries).toHaveLength(2);

    const search = entries.find((e) => e.path.join('/') === 'smlouvy/hledat');
    expect(search?.method).toBe('GET');
    expect(search?.httpPath).toBe('/smlouvy/hledat');
    expect(search?.summary).toBe('Search contracts');
    expect(search?.queryParams).toEqual([
      { name: 'dotaz', type: 'string', required: false, default: undefined, enum: undefined, description: 'fulltext' },
      { name: 'strana', type: 'integer', required: false, default: 1, enum: undefined, description: undefined },
      {
        name: 'razeni',
        type: 'integer',
        required: false,
        default: undefined,
        enum: [0, 1, 2, 3],
        description: undefined,
      },
    ]);

    const detail = entries.find((e) => e.path.join('/') === 'smlouvy/get');
    expect(detail?.pathParams).toEqual([
      { name: 'id', type: 'string', required: true, default: undefined, enum: undefined, description: undefined },
    ]);
  });

  test('skips parent groups that have no action', () => {
    const program = new Command();
    registerFromOpenApi(program, {
      paths: {
        '/api/v2/aitask/Check': { get: { summary: 'check' } },
      },
    });
    const entries = collectSchema(program);
    expect(entries.map((e) => e.path.join('/'))).toEqual(['aitask/Check']);
  });
});
