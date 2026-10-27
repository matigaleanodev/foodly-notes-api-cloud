import { Ajv } from 'ajv';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenApiDocument } from '../src/contracts/openapi.ts';
import { routes, methodsFor } from '../src/http/routes.ts';
import { httpErrorSchemas } from '../src/contracts/http.ts';
import {
  recipeSummarySchema,
  searchRecipesResponseSchema,
  ingredientsResponseSchema,
} from '../src/contracts/responses.ts';
import type {
  StoredRecipesResponse,
  DailyRecipesResponse,
  SearchRecipesResponse,
  SimilarRecipesResponse,
  RecipeDetailResponse,
  IngredientsResponse,
} from '../src/contracts/responses.ts';
import { ingredientsBody, recipeId, recipeQuery } from '../src/recipes/validation.ts';
import { storedQuery, createRecipeHandler } from '../src/recipes/handler.ts';
import { createHealthHandler } from '../src/health/handler.ts';
import { database } from '../src/runtime/database.ts';
import { context, env, event } from './helpers.ts';
import { expectResponseContract } from './response-contract.ts';

const ajv = new Ajv({ allErrors: true });
const document = createOpenApiDocument();
afterEach(() => vi.restoreAllMocks());

describe('Respuestas y OpenAPI desde contratos neutrales', () => {
  it('genera las trece operaciones sin body HEAD, preservando schemas, estados, headers y grupos', () => {
    expect(document.openapi).toBe('3.1.1');
    expect(document.jsonSchemaDialect).toBe('http://json-schema.org/draft-07/schema#');
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    const ids: string[] = [];
    for (const route of Object.values(routes)) {
      expect(Object.keys(document.paths[route.path]!)).toEqual(
        methodsFor(route).map((m) => m.toLowerCase()),
      );
      for (const method of methodsFor(route)) {
        const operation = document.paths[route.path]![method.toLowerCase()]!;
        ids.push(operation.operationId);
        expect(operation['x-lambda-group']).toBe(route.group);
        expect(Object.keys(operation.responses)).toEqual(Object.keys(route.responses));
        for (const [status, contract] of Object.entries(route.responses)) {
          expect(ajv.validateSchema(contract.schema)).toBe(true);
          const validate = ajv.compile(contract.schema);
          expect(validate).toBeTypeOf('function');
          expect(operation.responses[status]!.headers).toEqual(contract.headers);
          if (method === 'HEAD') expect(operation.responses[status]).not.toHaveProperty('content');
          else
            expect(operation.responses[status]!.content?.[contract.mediaType]?.schema).toEqual(
              contract.schema,
            );
        }
      }
    }
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    expect(document.security).toEqual([{ sigv4: [] }]);
    expect(document.paths['/api/health']!.get).not.toHaveProperty('requestBody');
    expect(
      document.paths['/api/recipes/ingredients']!.post!.requestBody!.content['application/json']!
        .schema,
    ).toBe(routes.ingredients.httpInput.body);
    expect(
      document.paths['/api/recipes']!.get!.parameters.find((p) => p.name === 'limit')!.required,
    ).toBe(false);
    expect(
      document.paths['/api/recipes/search']!.get!.parameters.find((p) => p.name === 'q')!.required,
    ).toBe(true);
    expect(
      document.paths['/api/recipes/{id}']!.head!.parameters.find((p) => p.name === 'id')!.required,
    ).toBe(true);
  });

  it('el generador y sus imports no cargan infraestructura, handlers, AJV ni clientes', async () => {
    const bundle = await build({
      entryPoints: ['src/contracts/openapi.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
    });
    expect(
      Object.keys(bundle.metafile!.inputs).every(
        (path) => path.startsWith('src/contracts/') || path === 'src/http/routes.ts',
      ),
    ).toBe(true);
  });

  it('deriva las seis respuestas y distingue imágenes opcionales, null y campos internos', () => {
    const stored: StoredRecipesResponse = [{ sourceId: 1, title: 'Rice' }];
    const daily: DailyRecipesResponse = stored;
    const similar: SimilarRecipesResponse = stored;
    const search: SearchRecipesResponse = [{ sourceId: 1, title: 'Rice', image: null }];
    const detail: RecipeDetailResponse = {
      sourceId: 1,
      title: 'Rice',
      summary: '',
      instructions: [],
      ingredients: [],
      lang: 'en',
      readyInMinutes: null,
    };
    const ingredients: IngredientsResponse = [{ sourceId: 1, title: 'Rice', ingredients: [] }];
    for (const [route, value] of [
      [routes.recipes, stored],
      [routes.daily, daily],
      [routes.similar, similar],
      [routes.search, search],
      [routes.detail, detail],
    ] as const)
      expect(ajv.compile(route.responses[200].schema)(value)).toBe(true);
    expect(ajv.compile(ingredientsResponseSchema)(ingredients)).toBe(true);
    const summary = ajv.compile(recipeSummarySchema);
    const searchResponse = ajv.compile(searchRecipesResponseSchema);
    expect(summary({ ...stored[0], image: null })).toBe(false);
    expect(searchResponse(stored)).toBe(false);
    expect(searchResponse(search)).toBe(true);
    expect(summary({ ...stored[0], _id: 'private' })).toBe(false);
    expect(ajv.compile(routes.detail.responses[200].schema)({ ...detail, lang: 'fr' })).toBe(false);
    expect(ajv.compile(ingredientsResponseSchema)([{ ...ingredients[0], lang: 'en' }])).toBe(false);
    for (const route of [routes.recipes, routes.daily, routes.search, routes.similar]) {
      const validate = ajv.compile(route.responses[200].schema);
      expect(validate([])).toBe(true);
      expect(
        validate(
          Array.from({ length: route.responses[200].schema.maxItems + 1 }, () =>
            route === routes.search ? search[0] : stored[0],
          ),
        ),
      ).toBe(false);
    }
  });

  it('documenta strings HTTP aceptados sin confundirlos con valores canónicos', () => {
    const raw = { limit: '001', after: '09007199254740991' };
    expect(ajv.compile(routes.recipes.httpInput.query)(raw)).toBe(true);
    expect(ajv.compile(routes.recipes.request.query)(raw)).toBe(false);
    expect(storedQuery(event('/api/recipes', new URLSearchParams(raw).toString()))).toEqual({
      limit: 1,
      after: Number.MAX_SAFE_INTEGER,
    });
    for (const value of ['1', '0001', '100', '00100'])
      expect(ajv.compile(routes.recipes.httpInput.query)({ limit: value })).toBe(true);
    for (const value of ['0', '101', '1e2', ' 1 ', '+1', '9007199254740992'])
      expect(ajv.compile(routes.recipes.httpInput.query)({ limit: value })).toBe(false);
    for (const value of ['1', '0001', '9007199254740990', '09007199254740991']) {
      expect(ajv.compile(routes.detail.httpInput.path)({ id: value })).toBe(true);
      expect(recipeId(value)).toBe(Number(value));
    }
    for (const value of ['0', '9007199254740992', '9999999999999999', '1e2'])
      expect(ajv.compile(routes.detail.httpInput.path)({ id: value })).toBe(false);
    const query = { q: '\n' + '🍲'.repeat(200) + '\t', lang: ' ES ' };
    expect(ajv.compile(routes.search.httpInput.query)(query)).toBe(true);
    expect(
      recipeQuery(event('/api/recipes/search', new URLSearchParams(query).toString()), true),
    ).toEqual({ q: '🍲'.repeat(200), lang: 'es' });
    expect(ajv.compile(routes.daily.httpInput.query)({ lang: ['en', 'en'] })).toBe(false);
    expect(ajv.compile(routes.daily.httpInput.query)({ extra: 'value' })).toBe(false);
    const body = { sourceIds: ['001', 2], lang: ' EN ' };
    const request = event('/api/recipes/ingredients', '', '127.0.0.1', 'POST');
    request.headers['content-type'] = 'application/json';
    request.body = JSON.stringify(body);
    expect(ajv.compile(routes.ingredients.httpInput.body)(body)).toBe(true);
    expect(ingredientsBody(request)).toEqual({ sourceIds: [1, 2], lang: 'en' });
    request.body = JSON.stringify({ sourceIds: [1, '001'] });
    expect(() => ingredientsBody(request)).toThrow('Invalid ingredients request');
    expect(document.info.description).toContain('unicidad');
    expect(document.paths['/api/recipes']!.get!['x-canonical-request']).toEqual(
      routes.recipes.request,
    );
  });

  it.each([200, 503])(
    'HEAD health %s omite JSON y mantiene headers sin consumir cuotas',
    async (statusCode) => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const ping = vi.fn(async () => {
        if (statusCode === 503) throw new Error('simulated');
      });
      const response = await createHealthHandler(env, { ping })(
        event('/api/health', '', '127.0.0.1', 'HEAD'),
        context,
      );
      expect(response.statusCode).toBe(statusCode);
      expectResponseContract(routes.health, response, 'HEAD');
      expect(ping).toHaveBeenCalledTimes(1);
    },
  );

  it('comprueba 403/404/414 y HEAD antes de cuotas en un handler fijo', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const increment = vi.fn(async () => 1);
    const handler = createRecipeHandler(
      routes.detail,
      { ...database(() => undefined), increment },
      env,
    );
    for (const method of ['GET', 'HEAD']) {
      const cases = [
        { request: event('/api/recipes/1', '', 'invalid', method), status: 403 },
        {
          request: event('/api/recipes/1', 'extra=' + 'x'.repeat(4096), '127.0.0.1', method),
          status: 414,
        },
        { request: event('/api/recipes/daily', '', '127.0.0.1', method), status: 404 },
      ];
      for (const { request, status } of cases) {
        const result = await handler(request, context);
        expect(result.statusCode).toBe(status);
        expectResponseContract(routes.detail, result, method);
      }
    }
    expect(increment).not.toHaveBeenCalled();
  });
  it('comprueba 500 inesperado y HEAD manteniendo saneamiento y seguridad de producción', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = {
      ...database(() => undefined),
      increment: async () => 1,
      list: async () => {
        throw new Error('private');
      },
    };
    const handler = createRecipeHandler(routes.recipes, db, { ...env, NODE_ENV: 'production' });
    for (const method of ['GET', 'HEAD']) {
      const response = await handler(event('/api/recipes', '', '127.0.0.1', method), context);
      expectResponseContract(routes.recipes, response, method);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private');
      expect(response.headers?.['strict-transport-security']).toBe('max-age=31536000');
    }
    for (const [status, schema] of Object.entries(httpErrorSchemas)) {
      const validate = ajv.compile(schema);
      expect(validate({ statusCode: Number(status), message: 'private' })).toBe(false);
    }
  });
});
