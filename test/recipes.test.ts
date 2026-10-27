import { type JsonHttpClient, JsonHttpError } from '../src/runtime/http-client.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { database, type Database } from '../src/runtime/database.ts';
import { createRecipesHandler } from './gateway.ts';
import { providers, providerAccess } from '../src/recipes/providers/client.ts';
import { recipeSchema, dailySchema, translationSchema } from '../src/recipes/models.ts';
import { context, env, event } from './helpers.ts';
import type { SpoonacularRecipeDetail } from '../src/recipes/providers/types.ts';

export function detailFixture(id: number): SpoonacularRecipeDetail {
  return {
    id,
    title: `Recipe ${id}`,
    summary:
      '<p onclick="bad()">Good <b>food</b><script>bad()</script><a href="javascript:bad()">link</a></p>',
    instructions: '',
    image: 'javascript:bad()',
    readyInMinutes: 25,
    servings: 2,
    vegetarian: true,
    vegan: false,
    glutenFree: true,
    dairyFree: false,
    cookingMinutes: 20,
    preparationMinutes: 5,
    healthScore: 70,
    aggregateLikes: 3,
    sourceName: 'Source',
    sourceUrl: 'https://source.example/recipe',
    analyzedInstructions: [{ steps: [{ number: 1, step: 'Cook' }] }],
    extendedIngredients: [
      {
        id: 9,
        name: 'rice',
        original: '1 cup rice',
        amount: 1,
        unit: 'cup',
        image: 'javascript:bad()',
      },
    ],
  };
}

const providerEnv = {
  ...env,
  SPOONACULAR_BASE_URL: 'https://spoon.invalid',
  SPOONACULAR_API_KEY: 'fixture',
  AZURE_TRANSLATOR_KEY: 'fixture',
  AZURE_TRANSLATOR_REGION: 'fixture',
  RATE_LIMIT_GLOBAL: '1000',
};

function post(ids: (number | string)[], lang = 'en') {
  const request = event('/api/recipes/ingredients', '', '198.51.100.10', 'POST');
  request.headers['content-type'] = 'application/json';
  request.body = JSON.stringify({ sourceIds: ids, lang });
  return request;
}

const jsonResponse = (value: unknown) => value;

describe('Etapa 3: contratos con proveedores simulados y Mongo efímero', () => {
  let mongo: MongoMemoryServer;
  let db: Database;
  let transport: ReturnType<typeof vi.fn<JsonHttpClient>>;
  let handler: ReturnType<typeof createRecipesHandler>;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      binary: { version: '8.2.6' },
      instance: { ip: '127.0.0.1' },
    });
    db = database(() => mongo.getUri('foodly_notes_stage3_test'));
    const connection = await db.connect();
    // Preparación explícita solo sobre la base efímera; runtime conserva autoIndex=false.
    await connection.model('StoredRecipe', recipeSchema).createIndexes();
    await connection.model('DailyRecipe', dailySchema).createIndexes();
    await connection.model('TranslationEntry', translationSchema).createIndexes();
  });
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const connection = await db.connect();
    for (const collection of ['recipes', 'dailyrecipes', 'translationentries', 'securitycounters'])
      await connection.collection(collection).deleteMany({});
    transport = vi.fn<JsonHttpClient>(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.cognitive.microsofttranslator.com') {
        const body = JSON.parse(String(init?.body)) as { text: string }[];
        return jsonResponse(
          body.map(({ text }) => ({
            translations: [{ text: `${url.searchParams.get('to')}:${text}` }],
          })),
        );
      }
      if (url.pathname.endsWith('/informationBulk'))
        return jsonResponse(
          url.searchParams
            .get('ids')!
            .split(',')
            .map((id) => detailFixture(Number(id)))
            .reverse(),
        );
      const id = /recipes\/(\d+)/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith('/information')) return jsonResponse(detailFixture(Number(id)));
      if (url.pathname.endsWith('/random'))
        return jsonResponse({
          recipes: Array.from({ length: 12 }, (_, i) => ({
            id: i + 1,
            title: `Daily ${i + 1}`,
            image: 'daily.jpg',
          })),
        });
      if (url.pathname.endsWith('/complexSearch'))
        return jsonResponse({
          results: [
            { id: 71, title: 'Chicken', imageType: 'jpg' },
            { id: 72, title: 'Rice' },
          ],
        });
      if (url.pathname.endsWith('/similar'))
        return jsonResponse([{ id: 81, title: 'Similar', imageType: 'png' }]);
      throw new Error('Unexpected simulated URL');
    });
    handler = createRecipesHandler(db, providerEnv, providers(db, providerEnv, transport));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });

  it('detalle persiste esquema completo/defaults, sanea y reutiliza caché sin filtrar Mongo', async () => {
    const response = await handler(event('/api/recipes/42'), context);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({
      sourceId: 42,
      title: 'Recipe 42',
      summary: '<p>Good <b>food</b><a rel="noopener noreferrer">link</a></p>',
      instructions: [{ name: '', steps: [{ number: 1, text: 'Cook' }] }],
      ingredients: [
        { id: 9, name: 'rice', original: '1 cup rice', amount: 1, unit: 'cup', image: '' },
      ],
      readyInMinutes: 25,
      servings: 2,
      vegetarian: true,
      vegan: false,
      glutenFree: true,
      dairyFree: false,
      cookingMinutes: 20,
      preparationMinutes: 5,
      healthScore: 70,
      aggregateLikes: 3,
      sourceName: 'Source',
      sourceUrl: 'https://source.example/recipe',
      lang: 'en',
    });
    await handler(event('/api/recipes/42'), context);
    expect(transport).toHaveBeenCalledTimes(1);
    const stored = await (await db.connect()).collection('recipes').findOne({ sourceId: 42 });
    expect(stored).toMatchObject({
      source: 'spoonacular',
      originalLang: 'en',
      translations: {},
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(stored?.base.summary).not.toMatch(/script|onclick|javascript/);
  });
  it.each([{ summary: null }, {}])(
    'conserva resumen vacío si el proveedor lo omite o devuelve null: %j',
    async (fields) => {
      const value: Record<string, unknown> = { ...detailFixture(42), ...fields };
      if (!Object.hasOwn(fields, 'summary')) delete value.summary;
      transport.mockResolvedValueOnce(jsonResponse(value));
      const response = await handler(event('/api/recipes/42'), context);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body!).summary).toBe('');
    },
  );
  it('conserva null/omisión de metadatos, números negativos y arrays vacíos del caché', async () => {
    await handler(event('/api/recipes/42'), context);
    await (await db.connect()).collection('recipes').updateOne(
      { sourceId: 42 },
      {
        $set: {
          'meta.image': null,
          'meta.sourceUrl': null,
          'meta.sourceName': null,
          'meta.readyInMinutes': null,
          'meta.vegetarian': null,
          'meta.cookingMinutes': -1,
          'base.instructions': [],
          'base.ingredients': [],
        },
        $unset: { 'meta.servings': '', 'meta.healthScore': '' },
      },
    );
    const response = JSON.parse((await handler(event('/api/recipes/42'), context)).body!);
    expect(response).toMatchObject({
      readyInMinutes: null,
      vegetarian: null,
      sourceName: null,
      cookingMinutes: -1,
      instructions: [],
      ingredients: [],
    });
    for (const field of ['image', 'sourceUrl', 'servings', 'healthScore'])
      expect(response).not.toHaveProperty(field);
    expect(JSON.parse((await handler(post([42]), context)).body!)).toEqual([
      { sourceId: 42, title: 'Recipe 42', ingredients: [] },
    ]);
  });

  it('daily/similares omiten imagen ausente y búsqueda devuelve null incluso en arrays vacíos', async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (...args) => {
      const url = new URL(String(args[0]));
      if (url.pathname.endsWith('/random'))
        return jsonResponse({ recipes: [{ id: 1, title: 'Daily', image: 'javascript:bad()' }] });
      if (url.pathname.endsWith('/similar')) return jsonResponse([{ id: 2, title: 'Similar' }]);
      return normal(...args);
    });
    expect(JSON.parse((await handler(event('/api/recipes/daily'), context)).body!)).toEqual([
      { sourceId: 1, title: 'Daily' },
    ]);
    expect(JSON.parse((await handler(event('/api/recipes/42/similar'), context)).body!)).toEqual([
      { sourceId: 2, title: 'Similar' },
    ]);
    transport.mockResolvedValue(jsonResponse({ results: [] }));
    expect(
      JSON.parse((await handler(event('/api/recipes/search', 'q=rice'), context)).body!),
    ).toEqual([]);
  });
  it('SingleFlight comparte detalle y traducción concurrentes por instancia', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler(event('/api/recipes/42', 'lang=ES'), context)),
    );
    expect(results.every((r) => r.statusCode === 200 && JSON.parse(r.body!).lang === 'es')).toBe(
      true,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await (await db.connect()).collection('recipes').countDocuments()).toBe(1);
    await handler(event('/api/recipes/42', 'lang=es'), context);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('conserva instrucciones/metadatos y sanea HTML traducido y caché histórica al responder', async () => {
    await handler(event('/api/recipes/42', 'lang=es'), context);
    const response = JSON.parse(
      (await handler(event('/api/recipes/42', 'lang=es'), context)).body!,
    );
    expect(response).toMatchObject({
      title: 'es:Recipe 42',
      lang: 'es',
      servings: 2,
      instructions: [{ name: '', steps: [{ number: 1, text: 'es:Cook' }] }],
      ingredients: [{ name: 'es:rice', original: 'es:1 cup rice', amount: 1, unit: 'cup' }],
    });
    await (await db.connect()).collection('recipes').updateOne(
      { sourceId: 42 },
      {
        $set: {
          'translations.es.summary': '<img src=x onerror=bad()><b>Safe</b>',
          'meta.sourceUrl': 'javascript:bad()',
        },
      },
    );
    const historical = JSON.parse(
      (await handler(event('/api/recipes/42', 'lang=es'), context)).body!,
    );
    expect(historical.summary).toBe('<b>Safe</b>');
    expect(historical).not.toHaveProperty('sourceUrl');
  });
  it('fallo de Azure no persiste traducción completa ni impide detalle/ingredientes base', async () => {
    transport.mockImplementation(async (input) =>
      String(input).includes('microsofttranslator')
        ? Promise.reject(new JsonHttpError('HTTP_STATUS', 503))
        : jsonResponse(detailFixture(42)),
    );
    const response = await handler(event('/api/recipes/42', 'lang=es'), context);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toMatchObject({ title: 'Recipe 42', lang: 'en' });
    const ingredients = await handler(post([42], 'es'), context);
    expect(ingredients.statusCode).toBe(201);
    expect(JSON.parse(ingredients.body!)[0].ingredients[0].name).toBe('rice');
    expect((await db.recipe(42, AbortSignal.timeout(1000)))?.translations).toEqual({});
  });
  it('daily/search tienen precedencia sobre id y daily persiste selección UTC con títulos base', async () => {
    const first = await handler(event('/api/recipes/daily', 'lang=es'), context);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body!)).toHaveLength(12);
    expect(JSON.parse(first.body!)[0]).toEqual({
      sourceId: 1,
      title: 'es:Daily 1',
      image: 'daily.jpg',
    });
    const second = await handler(event('/api/recipes/daily'), context);
    expect(JSON.parse(second.body!)[0].title).toBe('Daily 1');
    const cached = await (
      await db.connect()
    )
      .collection('dailyrecipes')
      .findOne({ date: new Date().toISOString().slice(0, 10) });
    expect(cached?.recipes[0].title).toBe('Daily 1');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('búsqueda traduce solo la consulta y cachea texto/idioma conservando títulos e imagen null', async () => {
    const first = await handler(
      event('/api/recipes/search', 'q=%20pollo%20&lang=%20ES%20'),
      context,
    );
    expect(JSON.parse(first.body!)).toEqual([
      {
        sourceId: 71,
        title: 'Chicken',
        image: 'https://img.spoonacular.com/recipes/71-556x370.jpg',
      },
      { sourceId: 72, title: 'Rice', image: null },
    ]);
    expect(new URL(String(transport.mock.calls[1]![0])).searchParams.get('query')).toBe('en:pollo');
    await handler(event('/api/recipes/search', 'q=pollo&lang=es'), context);
    expect(
      transport.mock.calls.filter(([url]) => String(url).includes('microsofttranslator')),
    ).toHaveLength(1);
    expect(
      await (
        await db.connect()
      )
        .collection('translationentries')
        .findOne({ sourceText: 'pollo', targetLang: 'en' }),
    ).toMatchObject({ translatedText: 'en:pollo', createdAt: expect.any(Date) });
  });
  it('búsqueda conserva consulta original ante fallo de traducción y similares devuelve títulos traducidos', async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (...args) =>
      String(args[0]).includes('microsofttranslator')
        ? Promise.reject(new JsonHttpError('HTTP_STATUS', 500))
        : normal(...args),
    );
    expect(
      (await handler(event('/api/recipes/search', 'q=pollo&lang=es'), context)).statusCode,
    ).toBe(200);
    expect(new URL(String(transport.mock.calls[1]![0])).searchParams.get('query')).toBe('pollo');
    const base = JSON.parse(
      (await handler(event('/api/recipes/42/similar', 'lang=es'), context)).body!,
    );
    expect(base).toEqual([
      {
        sourceId: 81,
        title: 'Similar',
        image: 'https://img.spoonacular.com/recipes/81-556x370.png',
      },
    ]);
    transport.mockImplementation(normal);
    const translated = JSON.parse(
      (await handler(event('/api/recipes/42/similar', 'lang=es'), context)).body!,
    );
    expect(translated[0].title).toBe('es:Similar');
  });
  it('normaliza query/path y conserva HEAD y parámetros de path ignorados en las cuatro operaciones', async () => {
    const targets = [
      ['/api/recipes/daily', 'lang=%20EN%20'],
      ['/api/recipes/search', 'q=%20rice%20&lang=%20EN%20'],
      ['/api/recipes/00042', 'lang=%20EN%20'],
      ['/api/recipes/00042/similar', 'lang=%20EN%20'],
    ];
    for (const [path, query] of targets) {
      for (const method of ['GET', 'HEAD']) {
        const request = event(path, query, '127.0.0.1', method);
        request.pathParameters = { ...request.pathParameters, ignored: 'value' };
        const response = await handler(request, context);
        expect(response).toMatchObject({
          statusCode: 200,
          headers: { 'cache-control': 'no-store' },
        });
        if (method === 'HEAD') expect(response.body).toBe('');
        else expect(JSON.parse(response.body!)).toBeDefined();
      }
    }
    const urls = transport.mock.calls.map(([url]) => new URL(String(url)));
    expect(
      urls.filter((url) => url.pathname.endsWith('/information')).map((url) => url.pathname),
    ).toEqual(['/recipes/42/information']);
    expect(
      urls
        .filter((url) => url.pathname.endsWith('/complexSearch'))
        .every((url) => url.searchParams.get('query') === 'rice'),
    ).toBe(true);
    expect(urls.some((url) => url.pathname === '/recipes/42/similar')).toBe(true);
  });

  it('ingredientes conserva orden, cantidades y separación de recetas en lotes de 20', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 20 - i);
    const response = await handler(post(ids), {
      ...context,
      getRemainingTimeInMillis: () => 29000,
    });
    expect(response.statusCode).toBe(201);
    const result = JSON.parse(response.body!);
    expect(result.map((r: { sourceId: number }) => r.sourceId)).toEqual(ids);
    expect(
      result.every(
        (r: { ingredients: { amount: number }[] }) =>
          r.ingredients.length === 1 && r.ingredients[0]!.amount === 1,
      ),
    ).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    await handler(post(ids), context);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('propaga 404/502 de Spoonacular y rechaza payload de proveedor inválido sin persistir', async () => {
    transport.mockRejectedValueOnce(new JsonHttpError('HTTP_STATUS', 404));
    expect(await handler(event('/api/recipes/99'), context)).toMatchObject({
      statusCode: 404,
      body: '{"statusCode":404,"message":"Recipe not found.","error":"Not Found"}',
    });
    transport.mockRejectedValueOnce(new JsonHttpError('HTTP_STATUS', 503));
    expect((await handler(event('/api/recipes/99'), context)).statusCode).toBe(502);
    transport.mockResolvedValueOnce(jsonResponse({ id: 99, title: 'Incomplete' }));
    expect((await handler(event('/api/recipes/99'), context)).statusCode).toBe(502);
    expect(await (await db.connect()).collection('recipes').countDocuments()).toBe(0);
  });
  it.each([404, 503])(
    'HEAD conserva el error de proveedor HTTP %s y omite su JSON',
    async (status) => {
      transport.mockRejectedValueOnce(new JsonHttpError('HTTP_STATUS', status));
      const response = await handler(event('/api/recipes/99', '', '127.0.0.1', 'HEAD'), context);
      expect(response).toMatchObject({ statusCode: status === 404 ? 404 : 502, body: '' });
    },
  );
  it('presupuestos persisten aun con fallos, bloquean antes de llamar y Azure agotado devuelve base', async () => {
    const limitedEnv = {
      ...providerEnv,
      SPOONACULAR_DAILY_REQUEST_LIMIT: '1',
      AZURE_DAILY_CHARACTER_LIMIT: '1',
    };
    const limited = createRecipesHandler(db, limitedEnv, providers(db, limitedEnv, transport));
    expect((await limited(event('/api/recipes/1', 'lang=es'), context)).statusCode).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await limited(event('/api/recipes/2'), context)).toMatchObject({
      statusCode: 503,
      headers: { 'retry-after': expect.any(String) },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await limited(event('/api/recipes/1'), context)).statusCode).toBe(200);
  });
  it('presupuesto atómico compartido entre conexiones no permite exceder límite ni cambia al reiniciar handler', async () => {
    const other = database(() => mongo.getUri('foodly_notes_stage3_test'));
    const settings = { SPOONACULAR_DAILY_REQUEST_LIMIT: '3', AZURE_DAILY_CHARACTER_LIMIT: '7' };
    const access = [providerAccess(db, settings), providerAccess(other, settings)];
    const external = vi.fn(async () => 'ok');
    const signal = AbortSignal.timeout(3000);
    try {
      const requests = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => access[i % 2]!('spoonacular', 1, signal, external)),
      );
      expect(requests.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(external).toHaveBeenCalledTimes(3);
      const azure = await Promise.allSettled([
        access[0]!('azure', 4, signal, external),
        access[1]!('azure', 4, signal, external),
      ]);
      expect(azure.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const counters = await (await db.connect()).collection('securitycounters').find({}).toArray();
      expect(counters.map((c) => c.count).sort()).toEqual([3, 4]);
      expect(counters.every((c) => c.expiresAt instanceof Date)).toBe(true);
      await expect(
        providerAccess(other, settings)('spoonacular', 1, signal, external),
      ).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      await other.close();
    }
  });
  it('cuotas de búsqueda/similares/ingredientes conservan claves Nest y límites 20/20/10', async () => {
    const cases = [
      { operation: 'searchRecipes', limit: 20, request: event('/api/recipes/search', 'q=rice') },
      { operation: 'getSimilarRecipes', limit: 20, request: event('/api/recipes/42/similar') },
      { operation: 'getIngredients', limit: 10, request: post([42]) },
    ];
    const connection = await db.connect();
    for (const { operation, limit, request } of cases) {
      const key = createHash('sha256')
        .update(`RecipesController-${operation}-default-198.51.100.10`)
        .digest('hex');
      await connection
        .collection<{ _id: string; count: number; expiresAt: Date }>('securitycounters')
        .insertOne({
          _id: `throttle:${key}:${Math.floor(Date.now() / 60000)}`,
          count: limit,
          expiresAt: new Date(Date.now() + 60000),
        });
      expect(await handler(request, context)).toMatchObject({
        statusCode: 429,
        headers: { 'retry-after': expect.any(String) },
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('índices únicos y TTL conservan claves y no hay TTL para recetas o selección diaria', async () => {
    const connection = await db.connect();
    expect(await connection.collection('recipes').indexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'recipe_source_unique',
          unique: true,
          key: { sourceId: 1 },
        }),
      ]),
    );
    expect(await connection.collection('dailyrecipes').indexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'daily_date_unique', unique: true, key: { date: 1 } }),
      ]),
    );
    const translations = await connection.collection('translationentries').indexes();
    expect(translations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unique: true, key: { sourceText: 1, targetLang: 1 } }),
        expect.objectContaining({ name: 'translation_cache_expiry', expireAfterSeconds: 2592000 }),
      ]),
    );
  });
  it('carreras de caché entre conexiones conservan un único ganador persistido', async () => {
    const other = database(() => mongo.getUri('foodly_notes_stage3_test'));
    try {
      const second = createRecipesHandler(
        other,
        providerEnv,
        providers(other, providerEnv, transport),
      );
      const responses = await Promise.all([
        handler(event('/api/recipes/42'), context),
        second(event('/api/recipes/42'), context),
      ]);
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(responses[0]!.body).toBe(responses[1]!.body);
      const dailies = await Promise.all([
        handler(event('/api/recipes/daily'), context),
        second(event('/api/recipes/daily'), context),
      ]);
      expect(dailies.every((r) => r.statusCode === 200)).toBe(true);
      expect(dailies[0]!.body).toBe(dailies[1]!.body);
      const connection = await db.connect();
      expect(await connection.collection('recipes').countDocuments()).toBe(1);
      expect(await connection.collection('dailyrecipes').countDocuments()).toBe(1);
    } finally {
      await other.close();
    }
  });
  it('daily cambia por fecha UTC y cada idioma usa su propia clave de traducción', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T23:59:59Z'));
      await handler(event('/api/recipes/daily', 'lang=es'), context);
      vi.setSystemTime(new Date('2030-01-02T00:00:01Z'));
      await handler(event('/api/recipes/daily'), context);
      expect(await (await db.connect()).collection('dailyrecipes').countDocuments()).toBe(2);
      expect(transport.mock.calls.filter(([url]) => String(url).includes('/random?'))).toHaveLength(
        2,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('falla cerrado sin llamar al proveedor si no puede verificar presupuesto', async () => {
    const broken = {
      ...db,
      reserve: async () => {
        throw new Error('private hostname');
      },
    };
    const limited = createRecipesHandler(
      broken,
      providerEnv,
      providers(broken, providerEnv, transport),
    );
    const response = await limited(event('/api/recipes/1'), context);
    expect(response).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    expect(response.body).not.toContain('private');
    expect(transport).not.toHaveBeenCalled();
  });
});
