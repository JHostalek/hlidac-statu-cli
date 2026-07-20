import { describe, expect, test } from 'bun:test';
import { CliFailure, exitCodeForFailure } from '../errors.js';
import { planCommands } from '../generator.js';
import { buildSchemaDocument, filterSchemaDocument } from './schema.js';

describe('buildSchemaDocument', () => {
  test('publishes a versioned, self-describing command contract', () => {
    const plans = planCommands({
      paths: {
        '/api/v2/smlouvy/hledat': {
          get: {
            summary: 'Search contracts',
            parameters: [{ name: 'dotaz', in: 'query', required: true, schema: { type: 'string' } }],
          },
        },
      },
    });

    expect(buildSchemaDocument(plans, '9.8.7')).toEqual({
      schemaVersion: 1,
      cliVersion: '9.8.7',
      globalOptions: [
        { name: 'json', flags: ['--json'], type: 'boolean' },
        { name: 'dry-run', flags: ['--dry-run'], type: 'boolean' },
        { name: 'output', flags: ['-o', '--output'], type: 'string' },
        { name: 'timeout', flags: ['--timeout'], type: 'string' },
        { name: 'completions', flags: ['--completions'], type: 'string' },
        { name: 'log-level', flags: ['--log-level'], type: 'string' },
        { name: 'help', flags: ['-h', '--help'], type: 'boolean' },
        { name: 'wizard', flags: ['--wizard'], type: 'boolean' },
        { name: 'version', flags: ['--version'], type: 'boolean' },
      ],
      errorCodes: [
        'INVALID_INPUT',
        'MISSING_CREDENTIALS',
        'REQUEST_TIMEOUT',
        'TRANSPORT_FAILURE',
        'HTTP_FAILURE',
        'BINARY_OUTPUT_REQUIRED',
        'OUTPUT_FAILURE',
        'SCHEMA_PATH_NOT_FOUND',
        'INTERNAL_FAILURE',
      ],
      commands: [
        {
          path: ['smlouvy', 'hledat'],
          method: 'GET',
          httpPath: '/smlouvy/hledat',
          summary: 'Search contracts',
          pathParams: [],
          queryParams: [
            {
              name: 'dotaz',
              type: 'string',
              schema: { type: 'string' },
              required: true,
              default: undefined,
              enum: undefined,
              description: undefined,
            },
          ],
          hasRequestBody: false,
          responses: [],
        },
      ],
    });
  });

  test('retains complete parameter schemas for machine discovery', () => {
    const document = buildSchemaDocument(
      planCommands({
        paths: {
          '/api/v2/smlouvy/hledat': {
            get: {
              parameters: [{ name: 'cpv', in: 'query', schema: { type: 'array', items: { type: 'string' } } }],
            },
          },
        },
      }),
      '9.8.7',
    );

    expect(document.commands[0].queryParams[0].schema).toEqual({ type: 'array', items: { type: 'string' } });
  });

  test('publishes request and response content metadata', () => {
    const document = buildSchemaDocument(
      planCommands({
        paths: {
          '/api/v2/datasety': {
            post: {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              responses: {
                '200': {
                  description: 'Created',
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Created' } } },
                },
              },
            },
          },
        },
      }),
      '9.8.7',
    );

    expect({ requestBody: document.commands[0].requestBody, responses: document.commands[0].responses }).toEqual({
      requestBody: {
        required: true,
        description: undefined,
        contentTypes: ['application/json'],
        schema: { type: 'object' },
      },
      responses: [
        {
          status: '200',
          description: 'Created',
          contentTypes: ['application/json'],
          schema: { $ref: '#/components/schemas/Created' },
        },
      ],
    });
  });
});

describe('filterSchemaDocument', () => {
  test('returns only commands beneath a requested group path', () => {
    const document = buildSchemaDocument(
      planCommands({
        paths: {
          '/api/v2/smlouvy/hledat': { get: {} },
          '/api/v2/smlouvy/{id}': { get: {} },
          '/api/v2/firmy/{ico}': { get: {} },
        },
      }),
      '9.8.7',
    );

    expect(filterSchemaDocument(document, ['smlouvy']).commands.map((command) => command.path)).toEqual([
      ['smlouvy', 'get'],
      ['smlouvy', 'hledat'],
    ]);
  });

  test('reports an unknown path with a stable code and safe suggestions', () => {
    const document = buildSchemaDocument(
      planCommands({ paths: { '/api/v2/smlouvy/hledat': { get: {} }, '/api/v2/firmy/{ico}': { get: {} } } }),
      '9.8.7',
    );

    let thrown: unknown;
    try {
      filterSchemaDocument(document, ['smlouvi']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'SCHEMA_PATH_NOT_FOUND',
      retryable: false,
      details: { path: ['smlouvi'], suggestions: [['smlouvy']] },
    });
    expect(thrown).toBeInstanceOf(CliFailure);
    expect(exitCodeForFailure(thrown as CliFailure)).toBe(2);
  });
});

describe('hs schema', () => {
  test('prints a filtered versioned document without credentials', async () => {
    const process = Bun.spawn(
      [Bun.which('bun') ?? 'bun', 'src/cli.ts', 'schema', 'datasety', 'zaznamy', 'post-by-item-id'],
      { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    const document = JSON.parse(stdout);
    expect({
      exitCode,
      stderr,
      schemaVersion: document.schemaVersion,
      commandPaths: document.commands.map((c: { path: string[] }) => c.path),
    }).toEqual({
      exitCode: 0,
      stderr: '',
      schemaVersion: 1,
      commandPaths: [['datasety', 'zaznamy', 'post-by-item-id']],
    });
  });
});
