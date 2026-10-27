import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHash } from 'node:crypto';
import { database, type Database } from '../packages/runtime/src/runtime/database.ts';
import { createRecipesHandler } from './gateway.ts';
import { context, env, event } from './helpers.ts';

describe('Listado y cuotas con Mongo efímero aislado', () => {
  let mongo: MongoMemoryServer;
  let db: Database;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      binary: { version: '8.2.6' },
      instance: { ip: '127.0.0.1' },
    });
    db = database(() => mongo.getUri('foodly_notes_stage2_test'));
    const connection = await db.connect();
    await connection
      .collection('securitycounters')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'security_counter_expiry' });
  });
  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const connection = await db.connect();
    await connection.collection('recipes').deleteMany({});
    await connection.collection('securitycounters').deleteMany({});
    await connection.collection('recipes').insertMany([
      {
        sourceId: 30,
        base: { title: 'Third', summary: 'hidden' },
        meta: { image: 'javascript:bad' },
        translations: { es: { title: 'Tercera' } },
      },
      { sourceId: 10, base: { title: 'First' }, meta: { image: 'https://img.example/10.png' } },
      { sourceId: 20, base: { title: 'Second' }, meta: { image: '20.png' }, source: 'spoonacular' },
    ]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });

  it('devuelve array ordenado/paginado con títulos base y sin campos internos', async () => {
    const handler = createRecipesHandler(db, env);
    const response = await handler(event('/api/recipes', 'limit=1&after=10'), context);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual([
      { sourceId: 20, title: 'Second', image: '20.png' },
    ]);
    const all = await handler(event(), context);
    expect(JSON.parse(all.body!)).toEqual([
      { sourceId: 10, title: 'First', image: 'https://img.example/10.png' },
      { sourceId: 20, title: 'Second', image: '20.png' },
      { sourceId: 30, title: 'Third' },
    ]);
    expect(JSON.parse((await handler(event('/api/recipes', 'after=30'), context)).body!)).toEqual(
      [],
    );
    expect(
      await handler(event('/api/recipes', 'limit=001&after=010', '198.51.100.10', 'HEAD'), context),
    ).toMatchObject({ statusCode: 200, body: '' });
  });
  it('comparte conexión/promise entre llamadas concurrentes y reutiliza la conexión lista', async () => {
    const other = database(() => mongo.getUri('foodly_notes_stage2_connection'));
    try {
      const [a, b] = await Promise.all([other.connect(), other.connect()]);
      expect(a).toBe(b);
      expect(await other.connect()).toBe(a);
      expect(a.getClient().options).toMatchObject({ maxPoolSize: 4, minPoolSize: 0 });
    } finally {
      await other.close();
    }
  });
  it('contadores atómicos impiden exceder la cuota entre handlers/conexiones concurrentes', async () => {
    const other = database(() => mongo.getUri('foodly_notes_stage2_test'));
    try {
      const config = { ...env, RATE_LIMIT_PER_ROUTE: '3', RATE_LIMIT_GLOBAL: '100' };
      const handlers = [createRecipesHandler(db, config), createRecipesHandler(other, config)];
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => handlers[i % 2]!(event(), context)),
      );
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(3);
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(9);
      expect(
        responses.find((response) => response.statusCode === 429)?.headers?.['retry-after'],
      ).toBeDefined();
    } finally {
      await other.close();
    }
  });
  it('consume contadores con claves compatibles con Nest y no confía en X-Forwarded-For', async () => {
    const now = Date.now();
    const key = createHash('sha256').update('global:198.51.100.10').digest('hex');
    const connection = await db.connect();
    await connection
      .db!.collection<{ _id: string; count: number; expiresAt: Date }>('securitycounters')
      .insertOne({
        _id: `throttle:${key}:${Math.floor(now / 60000)}`,
        count: 120,
        expiresAt: new Date(now + 60000),
      });
    const request = event();
    request.headers['x-forwarded-for'] = '198.51.100.99';
    const response = await createRecipesHandler(db, env)(request, context);
    expect(response.statusCode).toBe(429);
  });
  it.each([
    ['/api/recipes', 'limit=101'],
    ['/api/recipes/daily', 'lang=fr'],
    ['/api/recipes/search', 'q='],
    ['/api/recipes/0', ''],
    ['/api/recipes/0/similar', 'lang=fr'],
  ])(
    'cuenta entrada inválida %s en ambas cuotas sin consultar proveedores',
    async (path, query) => {
      const handler = createRecipesHandler(db, env);
      const response = await handler(event(path, query), context);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body!).message).toEqual(expect.any(Array));
      const connection = await db.connect();
      const counters = await connection.collection('securitycounters').find().toArray();
      expect(counters).toHaveLength(2);
      expect(counters.every((counter) => counter.count === 1)).toBe(true);
    },
  );
  it('fallo inesperado de consulta conserva 500 sin filtrar detalles', async () => {
    const broken: Database = {
      ...db,
      list: async () => {
        throw new Error('secret database hostname');
      },
    };
    const response = await createRecipesHandler(broken, env)(event(), context);
    expect(response).toMatchObject({
      statusCode: 500,
      body: '{"statusCode":500,"message":"Internal server error"}',
    });
    expect(response.body).not.toMatch(/secret|hostname/);
  });
  it('deadline agotado cancela operaciones y devuelve 503 con reintento controlado', async () => {
    const delayed: Database = {
      ...db,
      list: async (_limit, _after, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        signal.throwIfAborted();
        return [];
      },
    };
    const response = await createRecipesHandler(delayed, env)(event(), {
      ...context,
      getRemainingTimeInMillis: () => 501,
    });
    expect(response).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
  });
  it('no crea índices ni colecciones desde modelos runtime', async () => {
    const connection = await db.connect();
    expect(connection.config.autoIndex).toBe(false);
    expect(await connection.collection('recipes').indexes()).toHaveLength(1);
    expect(
      (await connection.collection('securitycounters').indexes()).map((index) => index.name),
    ).toEqual(['_id_', 'security_counter_expiry']);
  });
  it('una señal abortada impide consultar o escribir contadores', async () => {
    const signal = AbortSignal.abort();
    await expect(db.list(50, undefined, signal)).rejects.toThrow();
    await expect(db.increment('cancelled', new Date(), signal)).rejects.toThrow();
    const connection = await db.connect();
    expect(await connection.collection('securitycounters').countDocuments()).toBe(0);
  });

  it('permite recuperar un intento de conexión fallido sin cachear el rechazo', async () => {
    let uri: string | undefined;
    const recovering = database(() => uri);
    await expect(recovering.connect()).rejects.toThrow('MONGO_URI required.');
    uri = mongo.getUri('foodly_notes_stage2_recovery');
    try {
      expect((await recovering.connect()).readyState).toBe(1);
    } finally {
      await recovering.close();
    }
  });
});
