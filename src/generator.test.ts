import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { planCommand, registerFromOpenApi } from './generator.js';

describe('planCommand', () => {
  test('literal-terminal GET: path segments become nested tree, no suffix', () => {
    const plan = planCommand('/api/v2/smlouvy/hledat', 'get', {
      parameters: [
        { name: 'dotaz', in: 'query', schema: { type: 'string' } },
        { name: 'strana', in: 'query', schema: { type: 'integer' } },
      ],
    });
    expect(plan.tree).toEqual(['smlouvy', 'hledat']);
    expect(plan.pathParams).toEqual([]);
    expect(plan.queryParams.map((q) => q.name)).toEqual(['dotaz', 'strana']);
    expect(plan.path).toBe('/smlouvy/hledat');
    expect(plan.method).toBe('GET');
  });

  test('param-terminal GET: suffix tree with "get"', () => {
    const plan = planCommand('/api/v2/smlouvy/{id}', 'get', {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    expect(plan.tree).toEqual(['smlouvy', 'get']);
    expect(plan.pathParams).toEqual(['id']);
  });

  test('param-terminal DELETE: suffix tree with "delete"', () => {
    const plan = planCommand('/api/v2/datasety/{datasetId}', 'delete', {
      parameters: [{ name: 'datasetId', in: 'path', required: true }],
    });
    expect(plan.tree).toEqual(['datasety', 'delete']);
    expect(plan.pathParams).toEqual(['datasetId']);
  });

  test('literal-terminal non-GET: suffix tree with method name', () => {
    const plan = planCommand('/api/v2/datasety', 'post', { requestBody: {} });
    expect(plan.tree).toEqual(['datasety', 'post']);
    expect(plan.pathParams).toEqual([]);
    expect(plan.hasRequestBody).toBe(true);
  });

  test('literal-terminal GET with no params: bare resource tree', () => {
    const plan = planCommand('/api/v2/datasety', 'get', {});
    expect(plan.tree).toEqual(['datasety']);
    expect(plan.pathParams).toEqual([]);
  });

  test('nested literal + param-terminal: literals stay as tree, method appended', () => {
    const plan = planCommand('/api/v2/datasety/{datasetId}/zaznamy/{itemId}', 'post', {
      parameters: [
        { name: 'datasetId', in: 'path', required: true },
        { name: 'itemId', in: 'path', required: true },
      ],
      requestBody: {},
    });
    expect(plan.tree).toEqual(['datasety', 'zaznamy', 'post']);
    expect(plan.pathParams).toEqual(['datasetId', 'itemId']);
  });

  test('preserves literal casing (no lowercasing)', () => {
    const plan = planCommand('/api/v2/firmy/GetDetailInfo', 'get', {});
    expect(plan.tree).toEqual(['firmy', 'GetDetailInfo']);
  });

  test('strips /api/v2 prefix from stored path', () => {
    const plan = planCommand('/api/v2/ping/{text}', 'get', {});
    expect(plan.path).toBe('/ping/{text}');
    expect(plan.tree).toEqual(['ping', 'get']);
    expect(plan.pathParams).toEqual(['text']);
  });
});

describe('registerFromOpenApi', () => {
  test('registers all non-colliding plans, returns count', () => {
    const program = new Command();
    const result = registerFromOpenApi(program, {
      paths: {
        '/api/v2/smlouvy/hledat': {
          get: {
            summary: 'Search contracts',
            parameters: [{ name: 'dotaz', in: 'query', schema: { type: 'string' } }],
          },
        },
        '/api/v2/smlouvy/{id}': {
          get: {
            summary: 'Get contract by id',
            parameters: [{ name: 'id', in: 'path', required: true }],
          },
        },
      },
    });
    expect(result.registered).toBe(2);
    expect(result.skipped).toEqual([]);

    const smlouvy = program.commands.find((c) => c.name() === 'smlouvy');
    expect(smlouvy).toBeDefined();
    expect(smlouvy?.commands.map((c) => c.name())).toContain('hledat');
    expect(smlouvy?.commands.map((c) => c.name())).toContain('get');
  });

  test('attaches action to pre-existing parent created by child registration', () => {
    const program = new Command();
    const result = registerFromOpenApi(program, {
      paths: {
        '/api/v2/datasety/{datasetId}': { delete: { summary: 'Delete dataset' } },
        '/api/v2/datasety': { get: { summary: 'List datasets' } },
      },
    });
    expect(result.registered).toBe(2);
    const datasety = program.commands.find((c) => c.name() === 'datasety');
    expect(datasety?.description()).toBe('List datasets');
    expect(datasety?.commands.map((c) => c.name())).toContain('delete');
  });

  test('skips second plan on command-name collision', () => {
    const program = new Command();
    const result = registerFromOpenApi(program, {
      paths: {
        '/api/v2/x/{id}': {
          post: {
            summary: 'POST x by id',
            parameters: [{ name: 'id', in: 'path', required: true }],
            requestBody: {},
          },
        },
        '/api/v2/x': { post: { summary: 'POST x collection', requestBody: {} } },
      },
    });
    expect(result.registered).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe('/api/v2/x');
    expect(result.skipped[0].reason).toBe('command name collision');
  });

  test('skips unsupported HTTP methods (e.g. head, options)', () => {
    const program = new Command();
    const result = registerFromOpenApi(program, {
      paths: {
        '/api/v2/x': {
          get: { summary: 'x' },
          head: { summary: 'ignored' } as never,
        },
      },
    });
    expect(result.registered).toBe(1);
  });
});
