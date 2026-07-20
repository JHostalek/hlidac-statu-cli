import { describe, expect, test } from 'bun:test';
import { buildSchemaDocument } from './commands/schema.js';
import { type OpenApiSpec, planCommands } from './generator.js';
import spec from './openapi.json' with { type: 'json' };

describe('embedded OpenAPI contract', () => {
  test('recognizes every operation from API 2.5.0.1', () => {
    const plans = planCommands(spec as OpenApiSpec);

    expect(spec.openapi).toBe('3.0.4');
    expect(spec.info.title).toBe('HlidacStatu Api 2.5.0.1');
    expect(plans).toHaveLength(63);
    expect(plans.every((plan) => plan.registration === 'generated')).toBe(true);
  });

  test('plans all embedded operations with unique executable paths', () => {
    const plans = planCommands(spec as OpenApiSpec);
    const operationMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
    const sourceOperations = Object.entries(spec.paths)
      .flatMap(([path, pathItem]) =>
        Object.keys(pathItem)
          .filter((method) => operationMethods.has(method.toLowerCase()))
          .map((method) => `${method.toUpperCase()} ${path.replace(/^\/api\/v2/, '') || '/'}`),
      )
      .sort();
    const plannedOperations = plans.map((plan) => `${plan.method} ${plan.path}`).sort();
    const datasetPosts = plans
      .filter((plan) => plan.method === 'POST' && plan.tree.slice(0, 2).join('/') === 'datasety/zaznamy')
      .map((plan) => ({ tree: plan.tree, httpPath: plan.path, pathParams: plan.pathParams.map((p) => p.name) }));
    const dumpItems = plans.find((plan) => plan.path === '/dumpItems/{datatype}');

    expect({
      count: plans.length,
      uniqueCommandPaths: new Set(plans.map((plan) => plan.tree.join('\0'))).size,
      sourceOperations,
      plannedOperations,
      datasetPosts,
      dumpItemsPathParams: dumpItems?.pathParams.map((parameter) => parameter.name),
    }).toEqual({
      count: 63,
      uniqueCommandPaths: 63,
      sourceOperations,
      plannedOperations: sourceOperations,
      datasetPosts: [
        {
          tree: ['datasety', 'zaznamy', 'post'],
          httpPath: '/datasety/{datasetId}/zaznamy',
          pathParams: ['datasetId'],
        },
        {
          tree: ['datasety', 'zaznamy', 'post-by-item-id'],
          httpPath: '/datasety/{datasetId}/zaznamy/{itemId}',
          pathParams: ['datasetId', 'itemId'],
        },
      ],
      dumpItemsPathParams: ['datatype'],
    });
  });

  test('preserves discovery metadata for every embedded operation', () => {
    const typedSpec = spec as OpenApiSpec;
    const plans = planCommands(typedSpec);

    for (const plan of plans) {
      const sourcePath = `/api/v2${plan.path === '/' ? '' : plan.path}`;
      const operation = typedSpec.paths[sourcePath]?.[plan.method.toLowerCase()];
      expect(operation, `${plan.method} ${plan.path}`).toBeDefined();
      if (!operation) throw new Error(`missing source operation: ${plan.method} ${plan.path}`);

      const templateParams = [...plan.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const queryParams = (operation.parameters ?? [])
        .filter((parameter: { in: string }) => parameter.in === 'query')
        .map((parameter: { name: string }) => parameter.name);
      const requestContentTypes = Object.keys(operation.requestBody?.content ?? {}).sort();
      const responseMetadata = Object.entries(operation.responses ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, response]) => ({
          status,
          contentTypes: Object.keys(response.content ?? {}).sort(),
        }));

      expect({
        pathParams: plan.pathParams.map((parameter) => parameter.name),
        queryParams: plan.queryParams.map((parameter) => parameter.name),
        hasRequestBody: plan.hasRequestBody,
        requestContentTypes: plan.requestBody?.contentTypes ?? [],
        responseMetadata: plan.responses.map(({ status, contentTypes }) => ({ status, contentTypes })),
      }).toEqual({
        pathParams: templateParams,
        queryParams,
        hasRequestBody: operation.requestBody !== undefined,
        requestContentTypes,
        responseMetadata,
      });
    }
  });

  test('freezes the complete ordered schema contract for all 63 operations', () => {
    const document = buildSchemaDocument(planCommands(spec as OpenApiSpec), '0.0.0-test');
    const digest = new Bun.CryptoHasher('sha256').update(JSON.stringify(document)).digest('hex');

    expect(digest).toBe('a0f895e7cccab2bbdfb51b2852ad084118cd2354903a5967480a8dbbc5e82ab6');
  });
});
