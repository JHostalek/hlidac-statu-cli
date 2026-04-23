import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { getPlan, planCommand, registerFromOpenApi } from './generator.js';

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
    expect(plan.pathParams.map((p) => p.name)).toEqual(['id']);
  });

  test('param-terminal DELETE: suffix tree with "delete"', () => {
    const plan = planCommand('/api/v2/datasety/{datasetId}', 'delete', {
      parameters: [{ name: 'datasetId', in: 'path', required: true }],
    });
    expect(plan.tree).toEqual(['datasety', 'delete']);
    expect(plan.pathParams.map((p) => p.name)).toEqual(['datasetId']);
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
    expect(plan.pathParams.map((p) => p.name)).toEqual(['datasetId', 'itemId']);
  });

  test('preserves literal casing (no lowercasing)', () => {
    const plan = planCommand('/api/v2/firmy/GetDetailInfo', 'get', {});
    expect(plan.tree).toEqual(['firmy', 'GetDetailInfo']);
  });

  test('strips /api/v2 prefix from stored path', () => {
    const plan = planCommand('/api/v2/ping/{text}', 'get', {});
    expect(plan.path).toBe('/ping/{text}');
    expect(plan.tree).toEqual(['ping', 'get']);
    expect(plan.pathParams.map((p) => p.name)).toEqual(['text']);
  });

  test('synthesizes path-param entries when OpenAPI omits them', () => {
    const plan = planCommand('/api/v2/x/{id}', 'get', {});
    expect(plan.pathParams).toEqual([{ name: 'id', in: 'path', required: true }]);
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

  test('encodes type and default in flag description', () => {
    const program = new Command();
    registerFromOpenApi(program, {
      paths: {
        '/api/v2/x': {
          get: {
            summary: 'X',
            parameters: [
              {
                name: 'strana',
                in: 'query',
                description: 'page',
                schema: { type: 'integer', default: 1 },
              },
            ],
          },
        },
      },
    });
    const x = program.commands.find((c) => c.name() === 'x');
    const opt = x?.options.find((o) => o.long === '--strana');
    expect(opt?.description).toContain('integer');
    expect(opt?.description).toContain('default 1');
    expect(opt?.flags).toContain('<integer>');
  });

  test('parent group has no synthetic /path description', () => {
    const program = new Command();
    registerFromOpenApi(program, {
      paths: {
        '/api/v2/aitask/Check': { get: { summary: 'check' } },
      },
    });
    const aitask = program.commands.find((c) => c.name() === 'aitask');
    expect(aitask?.description()).toBe('');
  });

  test('attaches CommandPlan to leaf for schema introspection', () => {
    const program = new Command();
    registerFromOpenApi(program, {
      paths: {
        '/api/v2/smlouvy/hledat': {
          get: {
            summary: 'Search',
            parameters: [{ name: 'dotaz', in: 'query', schema: { type: 'string' } }],
          },
        },
      },
    });
    const hledat = program.commands.find((c) => c.name() === 'smlouvy')?.commands.find((c) => c.name() === 'hledat');
    const plan = hledat ? getPlan(hledat) : undefined;
    expect(plan?.method).toBe('GET');
    expect(plan?.path).toBe('/smlouvy/hledat');
    expect(plan?.queryParams.map((q) => q.name)).toEqual(['dotaz']);
  });
});
