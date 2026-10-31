import { type JsonHttpClient } from '../packages/runtime/src/runtime/http-client.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from '../packages/runtime/src/runtime/database.ts';
import { storedQuery } from '../packages/runtime/src/recipes/handler.ts';
import { recipeId, recipeQuery } from '../packages/runtime/src/recipes/validation.ts';
import { createRecipesHandler } from './gateway.ts';
import { providers } from '../packages/runtime/src/recipes/providers/client.ts';
import { context, env, event } from './helpers.ts';

const noProvider = vi.fn<JsonHttpClient>(async () => {
  throw new Error('No external calls allowed');
});
const db = { ...database(() => undefined), increment: async () => 1, reserve: async () => true };
const handler = () => createRecipesHandler(db, env, providers(db, env, noProvider));

function body(value: unknown, encoded = false) {
  const request = event('/api/recipes/ingredients', '', '127.0.0.1', 'POST');
  request.headers['Content-Type'] = 'application/json; charset=utf-8';
  const json = JSON.stringify(value);
  request.body = encoded ? Buffer.from(json).toString('base64') : json;
  request.isBase64Encoded = encoded;
  return request;
}

afterEach(() => {
  expect(noProvider).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
describe('Entradas y fallos HTTP afectados por recetas', () => {
  it.each([
    '/api/recipes/0',
    '/api/recipes/-1',
    '/api/recipes/1.5',
    '/api/recipes/9007199254740992',
    '/api/recipes/1e2',
    '/api/recipes/search?q=',
    '/api/recipes/search?q=%00bad',
    '/api/recipes/search?q=a&q=b',
    '/api/recipes/daily?lang=fr',
    '/api/recipes/daily?extra=x',
    '/api/recipes/42?lang=en&lang=es',
    '/api/recipes/42?q=bad',
  ])('rechaza entrada inválida sin proveedor: %s', async (target) => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const [path, query = ''] = target.split('?');
    expect((await handler()(event(path, query), context)).statusCode).toBe(400);
  });
  it.each(
    [
      {},
      { sourceIds: [] },
      { sourceIds: Array.from({ length: 21 }, (_, i) => i + 1) },
      { sourceIds: [1, '01'] },
      { sourceIds: [true] },
      { sourceIds: [null] },
      { sourceIds: [0] },
      { sourceIds: [1.5] },
      { sourceIds: ['1e2'] },
      { sourceIds: [9007199254740992] },
      { sourceIds: [1], lang: 'fr' },
      { sourceIds: [1], lang: null },
      { sourceIds: [1], lang: '' },
      { sourceIds: [1], lang: ['en'] },
      { sourceIds: [1], extra: true },
      [],
      null,
    ].map((value) => ({ value })),
  )('rechaza body inválido: %j', async ({ value }) => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await handler()(body(value), context);
    expect(response).toMatchObject({
      statusCode: 400,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
    expect(JSON.parse(response.body!)).toEqual({
      statusCode: 400,
      message: ['Invalid ingredients request'],
      error: 'Bad Request',
    });
  });
  it('normaliza IDs string, idioma y body base64 conservando la respuesta 201', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const store = {
      ...db,
      recipesByIds: async (ids: number[]) =>
        ids.map((id) => ({
          sourceId: id,
          source: 'spoonacular',
          originalLang: 'en',
          base: { title: 'Cached', summary: '', instructions: [], ingredients: [] },
          meta: {},
          translations: {},
        })),
    };
    const response = await createRecipesHandler(store, env)(
      {
        ...body({ sourceIds: ['001'], lang: ' EN ' }, true),
        rawQueryString: 'lang=fr&q=x&extra=y',
      },
      context,
    );
    expect(response).toMatchObject({
      statusCode: 201,
      headers: {
        'cache-control': 'no-store',
      },
    });
    expect(JSON.parse(response.body!)).toEqual([{ sourceId: 1, title: 'Cached', ingredients: [] }]);
  });
  it('rechaza antes de cuotas y persistencia y conserva prioridad de errores HTTP', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const increment = vi.fn(async () => 1);
    const recipesByIds = vi.fn(async () => []);
    const requestHandler = createRecipesHandler({ ...db, increment, recipesByIds }, env);
    const request = body({ sourceIds: [1, '01'] });
    expect((await requestHandler(request, context)).statusCode).toBe(400);
    request.headers['Content-Type'] = 'text/plain';
    request.body = 'x'.repeat(16385);
    const unsupported = await requestHandler(request, context);
    expect(unsupported.statusCode).toBe(415);
    expect(JSON.parse(unsupported.body!)).toEqual({
      statusCode: 415,
      message: 'Content-Type must be application/json.',
    });
    request.rawQueryString = 'q=' + 'x'.repeat(4096);
    expect((await requestHandler(request, context)).statusCode).toBe(414);
    expect(increment).not.toHaveBeenCalled();
    expect(recipesByIds).not.toHaveBeenCalled();
  });
  it('acepta límites de IDs y 16 KiB exactos, con idioma omitido o normalizado', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const recipesByIds = vi.fn(async (ids: number[]) =>
      ids.map((sourceId) => ({
        sourceId,
        source: 'spoonacular',
        originalLang: 'en',
        base: { title: 'Cached', summary: '', instructions: [], ingredients: [] },
        meta: {},
        translations: {},
      })),
    );
    const requestHandler = createRecipesHandler({ ...db, recipesByIds }, env);
    const ids = [...Array.from({ length: 19 }, (_, i) => i + 1), Number.MAX_SAFE_INTEGER];
    for (const lang of [undefined, ' EN ']) {
      for (const encoded of [false, true]) {
        const request = body({ sourceIds: ids.map(String), lang });
        request.body = request.body!.padEnd(16384);
        if (encoded) request.body = Buffer.from(request.body).toString('base64');
        request.isBase64Encoded = encoded;
        const response = await requestHandler(request, context);
        expect(response.statusCode).toBe(201);
        expect(
          JSON.parse(response.body!).map((recipe: { sourceId: number }) => recipe.sourceId),
        ).toEqual(ids);
        expect(recipesByIds).toHaveBeenLastCalledWith(ids, expect.any(AbortSignal));
      }
    }
  });
  it('rechaza content-type, JSON roto y más de 16 KiB incluyendo UTF-8 y base64', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const request = body({ sourceIds: [1] });
    request.headers['Content-Type'] = 'text/plain';
    expect((await handler()(request, context)).statusCode).toBe(415);
    request.headers['Content-Type'] = 'application/json';
    request.body = '{';
    expect((await handler()(request, context)).statusCode).toBe(400);
    for (const encoded of [true, false])
      expect(
        (await handler()(body({ sourceIds: [1], extra: 'á'.repeat(8192) }, encoded), context))
          .statusCode,
      ).toBe(413);
  });
  it('rechaza métodos/rutas ajenas y HEAD del detalle omite el cuerpo', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect((await handler()(event('/api/recipes/daily/extra'), context)).statusCode).toBe(404);
    expect(
      (await handler()(event('/api/recipes/42', '', '127.0.0.1', 'DELETE'), context)).statusCode,
    ).toBe(404);
    const response = await handler()(event('/api/recipes/0', '', '127.0.0.1', 'HEAD'), context);
    expect(response).toMatchObject({ statusCode: 400, body: '' });
  });
});

describe('Query/path neutrales conservan el contrato HTTP', () => {
  it('conserva defaults, normalización, enteros seguros y longitud Unicode de búsqueda', () => {
    expect(storedQuery(event('/api/recipes', 'limit=001&after=09007199254740991'))).toEqual({
      limit: 1,
      after: Number.MAX_SAFE_INTEGER,
    });
    expect(storedQuery(event('/api/recipes', 'limit=100'))).toEqual({ limit: 100 });
    expect(recipeQuery(event('/api/recipes/daily'))).toEqual({ lang: 'en' });
    expect(recipeQuery(event('/api/recipes/daily', 'lang=%20ES%20'))).toEqual({ lang: 'es' });
    expect(recipeQuery(event('/api/recipes/search', 'q=%0Arice%09'), true)).toEqual({
      q: 'rice',
      lang: 'en',
    });
    const q = '🍲'.repeat(200);
    expect(recipeQuery(event('/api/recipes/search', `q=${encodeURIComponent(q)}`), true)).toEqual({
      q,
      lang: 'en',
    });
    expect(() =>
      recipeQuery(event('/api/recipes/search', `q=${encodeURIComponent(q + 'a')}`), true),
    ).toThrow('Invalid recipe query');
    expect(recipeId('0001')).toBe(1);
    expect(recipeId('09007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['/api/recipes', 'limit=1&limit=1', 'limit must be integer'],
    ['/api/recipes', 'after=1&after=1', 'after must be integer'],
    ['/api/recipes', 'limit=%201%20', 'limit must be integer'],
    ['/api/recipes', 'limit=+1', 'limit must be integer'],
    ['/api/recipes', 'after=1e2', 'after must be integer'],
    ['/api/recipes', 'extra=x', 'property extra should not exist'],
    ['/api/recipes/daily', 'q=rice', 'Invalid recipe query'],
    ['/api/recipes/daily', 'lang=en&lang=en', 'Invalid recipe query'],
    ['/api/recipes/daily', 'lang=', 'Invalid recipe query'],
    ['/api/recipes/daily', 'lang=null', 'Invalid recipe query'],
    ['/api/recipes/search', '', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=%20%20', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=rice&q=rice', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=rice&lang=es&lang=es', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=rice&extra=x', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=ri%7Fce', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=ri%C2%85ce', 'Invalid recipe query'],
    ['/api/recipes/search', 'q=' + 'a'.repeat(201), 'Invalid recipe query'],
    ['/api/recipes/42', 'q=rice', 'Invalid recipe query'],
    ['/api/recipes/42/similar', 'lang=es&lang=en', 'Invalid recipe query'],
    ['/api/recipes/0', 'lang=fr', 'Invalid recipe query'],
    ['/api/recipes/0/similar', 'lang=fr', 'Invalid recipe query'],
    ['/api/recipes/0', '', 'id must be a positive safe integer'],
    ['/api/recipes/9007199254740992/similar', '', 'id must be a positive safe integer'],
    ['/api/recipes/%201', '', 'id must be a positive safe integer'],
  ])('preserva JSON de error y HEAD para %s?%s', async (path, query, message) => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const increment = vi.fn(async () => 1);
    const requestHandler = createRecipesHandler(
      { ...db, increment },
      env,
      providers(db, env, noProvider),
    );
    for (const method of ['GET', 'HEAD']) {
      const response = await requestHandler(event(path, query, '127.0.0.1', method), context);
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe(
        method === 'HEAD'
          ? ''
          : JSON.stringify({
              statusCode: 400,
              message: [message],
              error: 'Bad Request',
            }),
      );
    }
    expect(increment).toHaveBeenCalledTimes(4);
  });

  it('conserva todos los mensajes y su orden en listado', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await handler()(event('/api/recipes', 'limit=101&after=0&extra=x'), context);
    expect(JSON.parse(response.body!)).toEqual({
      statusCode: 400,
      message: ['property extra should not exist', 'limit must be <= 100', 'after must be >= 1'],
      error: 'Bad Request',
    });
  });

  it.each([
    ['/api/recipes', 'limit=101'],
    ['/api/recipes/daily', 'lang=fr'],
    ['/api/recipes/search', 'q='],
    ['/api/recipes/0', 'lang=fr'],
    ['/api/recipes/0/similar', 'lang=fr'],
  ])('prioriza cuota de ruta/global y su fallo antes de validar %s', async (path, query) => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (const failureAt of [1, 2]) {
      for (const statusCode of [429, 503]) {
        for (const method of ['GET', 'HEAD']) {
          const increment = vi.fn(async () => {
            if (increment.mock.calls.length === failureAt) {
              if (statusCode === 503) throw new Error('Simulated counter unavailable');
              return 1000;
            }
            return 1;
          });
          const requestHandler = createRecipesHandler(
            { ...db, increment },
            env,
            providers(db, env, noProvider),
          );
          const response = await requestHandler(event(path, query, '127.0.0.1', method), context);
          expect(response.statusCode).toBe(statusCode);
          expect(response.headers?.['retry-after']).toMatch(/^\d+$/);
          expect(increment).toHaveBeenCalledTimes(failureAt);
          expect(response.body).toBe(
            method === 'HEAD'
              ? ''
              : JSON.stringify(
                  statusCode === 429
                    ? { statusCode, message: 'ThrottlerException: Too Many Requests' }
                    : {
                        statusCode,
                        message: 'Request limit verification unavailable.',
                        error: 'Service Unavailable',
                      },
                ),
          );
        }
      }
    }
  });

  it('los controles HTTP comunes rechazan antes de consumir cuotas', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const increment = vi.fn(async () => 1);
    const requestHandler = createRecipesHandler({ ...db, increment }, env);
    expect(
      (await requestHandler(event('/api/recipes', 'limit=101', 'invalid'), context)).statusCode,
    ).toBe(403);
    expect(
      (await requestHandler(event('/api/recipes', 'extra=' + 'x'.repeat(4096)), context))
        .statusCode,
    ).toBe(414);
    expect(increment).not.toHaveBeenCalled();
  });
});
