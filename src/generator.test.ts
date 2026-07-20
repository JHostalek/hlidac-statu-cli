import { describe, expect, test } from 'bun:test';
import { type OpenApiSpec, planCommand, planCommands } from './generator.js';

function capturePlanningError(spec: OpenApiSpec): unknown {
  try {
    planCommands(spec);
  } catch (error) {
    return error;
  }
  throw new Error('expected command planning to fail');
}

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

describe('planCommands', () => {
  test('returns one deterministic plan per operation before CLI registration', () => {
    const plans = planCommands({
      paths: {
        '/api/v2/x/{id}': {
          post: {
            parameters: [{ name: 'id', in: 'path', required: true }],
            requestBody: {},
          },
        },
        '/api/v2/x': { post: { requestBody: {} } },
      },
    });

    expect(plans.map((plan) => ({ tree: plan.tree, httpPath: plan.path }))).toEqual([
      { tree: ['x', 'post'], httpPath: '/x' },
      { tree: ['x', 'post-by-id'], httpPath: '/x/{id}' },
    ]);
  });

  test('orders plans independently of OpenAPI insertion order', () => {
    const forward = planCommands({
      paths: {
        '/api/v2/zeta': { get: {} },
        '/api/v2/alfa': { post: {} },
      },
    });
    const reverse = planCommands({
      paths: {
        '/api/v2/alfa': { post: {} },
        '/api/v2/zeta': { get: {} },
      },
    });
    const project = (plans: ReturnType<typeof planCommands>) =>
      plans.map((plan) => ({ tree: plan.tree, method: plan.method, path: plan.path }));
    const expected = [
      { tree: ['alfa', 'post'], method: 'POST', path: '/alfa' },
      { tree: ['zeta'], method: 'GET', path: '/zeta' },
    ];

    expect([project(forward), project(reverse)]).toEqual([expected, expected]);
  });

  test('rejects a collision with no unique shortest route', () => {
    expect(
      capturePlanningError({
        paths: {
          '/api/v2/x/{id}': { post: {} },
          '/api/v2/x/{slug}': { post: {} },
        },
      }),
    ).toMatchObject({
      code: 'AMBIGUOUS_COMMAND_PATH',
      commandPath: ['x', 'post'],
      operations: ['POST /x/{id}', 'POST /x/{slug}'],
    });
  });

  test('rejects a disambiguated path that collides with a literal route', () => {
    expect(
      capturePlanningError({
        paths: {
          '/api/v2/x': { post: {} },
          '/api/v2/x/{id}': { post: {} },
          '/api/v2/x/post-by-id': { get: {} },
        },
      }),
    ).toMatchObject({
      code: 'AMBIGUOUS_COMMAND_PATH',
      commandPath: ['x', 'post-by-id'],
      operations: ['GET /x/post-by-id', 'POST /x/{id}'],
    });
  });

  test('keeps a future /schema endpoint executable through the documented raw fallback', () => {
    const spec = { paths: { '/api/v2/schema': { get: {} } } };
    const plans = planCommands(spec);

    expect(plans).toMatchObject([
      {
        tree: ['raw', 'GET', '/schema'],
        registration: 'raw',
        method: 'GET',
        path: '/schema',
      },
    ]);
  });

  test('rejects generated roots that collide with framework built-ins', () => {
    for (const root of ['help', 'version', 'completions', 'wizard']) {
      expect(capturePlanningError({ paths: { [`/api/v2/${root}`]: { get: {} } } })).toMatchObject({
        code: 'RESERVED_COMMAND_NAME',
        commandPath: [root],
        operations: [`GET /${root}`],
      });
    }
  });

  test('rejects framework built-ins at nested command positions', () => {
    expect(capturePlanningError({ paths: { '/api/v2/x/help': { get: {} } } })).toMatchObject({
      code: 'RESERVED_COMMAND_NAME',
      commandPath: ['x', 'help'],
      operations: ['GET /x/help'],
    });
  });

  test('rejects OpenAPI operation methods that the generator cannot expose', () => {
    expect(capturePlanningError({ paths: { '/api/v2/x': { head: {} } } })).toMatchObject({
      code: 'UNSUPPORTED_HTTP_METHOD',
      commandPath: ['x', 'head'],
      operations: ['HEAD /x'],
    });
  });

  test('rejects an operation that cannot produce a command path', () => {
    expect(capturePlanningError({ paths: { '/api/v2/': { get: {} } } })).toMatchObject({
      code: 'EMPTY_COMMAND_PATH',
      commandPath: [],
      operations: ['GET /'],
    });
  });

  test('rejects unsupported and reserved generated option names', () => {
    const specWithOption = (name: string, requestBody = false): OpenApiSpec => ({
      paths: {
        '/api/v2/x': {
          get: {
            parameters: [{ name, in: 'query' }],
            requestBody: requestBody ? {} : undefined,
          },
        },
      },
    });

    expect([
      capturePlanningError(specWithOption('bad name')),
      capturePlanningError(specWithOption('json')),
      capturePlanningError(specWithOption('data', true)),
    ]).toEqual([
      expect.objectContaining({ code: 'UNSUPPORTED_OPTION_NAME', parameter: 'bad name' }),
      expect.objectContaining({ code: 'RESERVED_OPTION_NAME', parameter: 'json' }),
      expect.objectContaining({ code: 'RESERVED_OPTION_NAME', parameter: 'data' }),
    ]);
  });

  test('rejects duplicate generated parameter names', () => {
    expect(
      capturePlanningError({
        paths: {
          '/api/v2/x': {
            get: {
              parameters: [
                { name: 'page', in: 'query' },
                { name: 'page', in: 'query' },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ code: 'DUPLICATE_PARAMETER_NAME', parameter: 'page' });
  });

  test('discovers and dereferences request body schemas', () => {
    const plan = planCommands({
      paths: {
        '/api/v2/x': {
          post: {
            requestBody: {
              required: true,
              description: 'Create X',
              content: {
                'text/plain': { schema: { $ref: '#/components/schemas/A' } },
                'application/json': { schema: { $ref: '#/components/schemas/A' } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { type: 'object', properties: { child: { $ref: '#/components/schemas/B' } } },
          B: { type: 'string' },
        },
      },
    } as never)[0];

    expect(plan.requestBody).toEqual({
      required: true,
      description: 'Create X',
      contentTypes: ['application/json', 'text/plain'],
      schema: { type: 'object', properties: { child: { type: 'string' } } },
    });
  });

  test('discovers compact response status and content metadata', () => {
    const plan = planCommands({
      paths: {
        '/api/v2/x': {
          post: {
            responses: {
              '400': { description: 'Bad input' },
              '200': {
                description: 'Created',
                content: {
                  'text/plain': { schema: { $ref: '#/components/schemas/Created' } },
                  'application/json': { schema: { $ref: '#/components/schemas/Created' } },
                },
              },
            },
          },
        },
      },
    })[0];

    expect(plan.responses).toEqual([
      {
        status: '200',
        description: 'Created',
        contentTypes: ['application/json', 'text/plain'],
        schema: { $ref: '#/components/schemas/Created' },
      },
      { status: '400', description: 'Bad input', contentTypes: [], schema: undefined },
    ]);
  });

  test('preserves array schemas and dereferences parameter enums', () => {
    const plan = planCommands({
      paths: {
        '/api/v2/x': {
          get: {
            parameters: [
              { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/Status' } },
              { name: 'cpv', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
            ],
          },
        },
      },
      components: { schemas: { Status: { type: 'integer', format: 'int32', enum: [0, 1, 100, -1] } } },
    } as never)[0];

    expect(plan.queryParams.map((parameter) => parameter.schema)).toEqual([
      { type: 'integer', format: 'int32', enum: [0, 1, 100, -1] },
      { type: 'array', items: { type: 'string' } },
    ]);
  });
});
