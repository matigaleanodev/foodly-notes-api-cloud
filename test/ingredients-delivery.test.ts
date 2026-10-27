import { type JsonHttpClient } from '../src/runtime/http-client.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { database, type Database } from '../src/runtime/database.ts';
import { recipeSchema, translationSchema } from '../src/recipes/models.ts';
import { providers } from '../src/recipes/providers/client.ts';
import { createRecipeHandler } from '../src/recipes/handler.ts';
import { routes } from '../src/http/routes.ts';
import { context, env, event } from './helpers.ts';

const settings = {
  ...env,
  SPOONACULAR_BASE_URL: 'https://spoon.invalid',
  SPOONACULAR_API_KEY: 'fixture',
  AZURE_TRANSLATOR_KEY: 'fixture',
  AZURE_TRANSLATOR_REGION: 'fixture',
};

describe('Duración local con Mongo efímero y proveedores simulados lentos', () => {
  let mongo: MongoMemoryServer;
  let db: Database;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      binary: { version: '8.2.6' },
      instance: { ip: '127.0.0.1' },
    });
    db = database(() => mongo.getUri('foodly_notes_delivery_test'));
    const connection = await db.connect();
    await connection.model('StoredRecipe', recipeSchema).createIndexes();
    await connection.model('TranslationEntry', translationSchema).createIndexes();
  });
  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });

  it('20 recetas españolas con 15 ingredientes únicos completan con latencia real simulada de 4,9 s por llamada', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let active = 0;
    let maxActive = 0;
    const transport = vi.fn<JsonHttpClient>(async (input, init) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await delay(4900, undefined, { signal: init?.signal ?? undefined });
        const url = new URL(String(input));
        const data = url.pathname.endsWith('/informationBulk')
          ? url.searchParams
              .get('ids')!
              .split(',')
              .reverse()
              .map((id) => ({
                id: Number(id),
                title: `Recipe ${id}`,
                summary: `Summary ${id}`,
                analyzedInstructions: [{ steps: [{ number: 1, step: `Cook ${id}` }] }],
                extendedIngredients: Array.from({ length: 15 }, (_, i) => ({
                  id: i + 1,
                  name: `Ingredient ${id} ${i}`,
                  original: `Original ${id} ${i}`,
                  amount: i + 1,
                  unit: 'cup',
                })),
              }))
          : (JSON.parse(String(init?.body)) as { text: string }[]).map(({ text }) => ({
              translations: [{ text: `es:${text}` }],
            }));
        return data;
      } finally {
        active--;
      }
    });
    try {
      const handler = createRecipeHandler(
        routes.ingredients,
        db,
        settings,
        providers(db, settings, transport),
      );
      const request = event('/api/recipes/ingredients', '', '127.0.0.1', 'POST');
      const ids = Array.from({ length: 20 }, (_, i) => 20 - i);
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify({ sourceIds: ids, lang: 'es' });
      const started = performance.now();
      const response = await handler(request, {
        ...context,
        getRemainingTimeInMillis: () => 29000,
      });
      const durationMs = Math.round(performance.now() - started);
      expect(response.statusCode).toBe(201);
      const result = JSON.parse(response.body!);
      expect(result.map((row: { sourceId: number }) => row.sourceId)).toEqual(ids);
      expect(result[0].title).toBe('es:Recipe 20');
      expect(result[0].ingredients).toHaveLength(15);
      expect(result[0].ingredients[0]).toMatchObject({ name: 'es:Ingredient 20 0', amount: 1 });
      expect(durationMs).toBeLessThan(27000);
      expect(maxActive).toBe(4);
      expect(active).toBe(0);
      // 660 textos únicos: siete lotes Azure en dos tandas, después de un único lote Spoonacular.
      expect(transport).toHaveBeenCalledTimes(8);
      const connection = await db.connect();
      const mongoStatus = await connection.db!.admin().serverStatus();
      const pool = connection.getClient().options;
      expect(pool.maxPoolSize).toBe(4);
      expect(pool.minPoolSize).toBe(0);
      expect(
        await connection
          .collection('recipes')
          .countDocuments({ 'translations.es': { $exists: true } }),
      ).toBe(20);
      const counters = await connection
        .collection('securitycounters')
        .find({ _id: /^budget:spoonacular:/ })
        .toArray();
      expect(counters[0]?.count).toBe(20);
      const before = transport.mock.calls.length;
      expect((await handler(request, context)).statusCode).toBe(201);
      expect(transport).toHaveBeenCalledTimes(before);
      log.mockRestore();
      console.info(
        JSON.stringify({
          scenario: 'local-mongo-simulated-providers',
          durationMs,
          recipes: 20,
          providerCalls: 8,
          maxActive,
          mongoConnections: mongoStatus.connections.current,
          mongoTotalCreated: mongoStatus.connections.totalCreated,
        }),
      );
    } finally {
      log.mockRestore();
    }
  }, 35000);
});
