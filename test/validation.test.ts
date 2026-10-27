import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from '../src/runtime/database.ts';
import { createRecipesHandler } from './gateway.ts';
import { providers } from '../src/recipes/providers/client.ts';
import { context, env, event } from './helpers.ts';

const noProvider = vi.fn<typeof fetch>(async () => {
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
      { sourceIds: [1], extra: true },
      [],
      null,
    ].map((value) => ({ value })),
  )('rechaza body inválido: %j', async ({ value }) => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect((await handler()(body(value), context)).statusCode).toBe(400);
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
      body({ sourceIds: ['001'], lang: ' EN ' }, true),
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
