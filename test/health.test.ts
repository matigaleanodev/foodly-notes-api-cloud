import { expectResponseContract } from './response-contract.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ajv } from 'ajv';
import type { HttpResult } from '../src/http/middleware.ts';
import { routes } from '../src/http/routes.ts';
import type { HealthResponse } from '../src/contracts/health.ts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHealthHandler } from '../src/health/handler.ts';
import { database, type Database } from '../src/runtime/database.ts';
import { context, env, event } from './helpers.ts';

const validateHealth = new Ajv().compile<HealthResponse>(routes.health.responses[200].schema);

function healthBody(response: HttpResult) {
  expectResponseContract(routes.health, response);
  const value: unknown = JSON.parse(response.body!);
  expect(validateHealth(value)).toBe(true);
  return value;
}

describe('Healthcheck independiente', () => {
  let mongo: MongoMemoryServer;
  let db: Database;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      binary: { version: '8.2.6' },
      instance: { ip: '127.0.0.1' },
    });
    db = database(() => mongo.getUri('foodly_notes_health_test'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });

  it('ping real a Mongo efímero no crea colecciones ni escribe cuotas', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handler = createHealthHandler(env, db);
    const response = await handler(event('/api/health'), context);
    expect(response.statusCode).toBe(200);
    expect(healthBody(response)).toEqual([
      { name: 'configuration', status: 'ok' },
      { name: 'mongo', status: 'ok' },
    ]);
    expect(await (await db.connect()).db!.listCollections().toArray()).toEqual([]);
  });

  it('configuración inválida no impide que Mongo pase su propio check', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ping = vi.fn(async () => undefined);
    const response = await createHealthHandler({ ...env, RATE_LIMIT_GLOBAL: '-1' }, { ping })(
      event('/api/health'),
      context,
    );
    expect(response.statusCode).toBe(503);
    expect(healthBody(response)).toEqual([
      { name: 'configuration', status: 'error' },
      { name: 'mongo', status: 'ok' },
    ]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('fallo Mongo conserva el check de configuración y oculta errores/credenciales', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ping = vi.fn(async () => {
      throw new Error('mongodb://private:secret@internal');
    });
    const response = await createHealthHandler(env, { ping })(event('/api/health'), context);
    expect(response).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    expect(healthBody(response)).toEqual([
      { name: 'configuration', status: 'ok' },
      { name: 'mongo', status: 'error' },
    ]);
    expect(JSON.stringify(response)).not.toMatch(/private|secret|internal/);
  });

  it('devuelve ambos fallos sin cortar los checks después del primero', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ping = vi.fn(async () => {
      throw new Error('offline');
    });
    const response = await createHealthHandler({ CORS_ORIGIN: '*' }, { ping })(
      event('/api/health'),
      context,
    );
    expect(healthBody(response)).toEqual([
      { name: 'configuration', status: 'error' },
      { name: 'mongo', status: 'error' },
    ]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('un check colgado termina a 2 s sin cambiar el resultado del otro', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    const pending = createHealthHandler(env, {
      ping: async (value) => {
        signal = value;
        await new Promise<void>(() => undefined);
      },
    })(event('/api/health'), context);
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    expect(response.statusCode).toBe(503);
    expect(signal?.aborted).toBe(true);
    expect(healthBody(response)).toEqual([
      { name: 'configuration', status: 'ok' },
      { name: 'mongo', status: 'error' },
    ]);
  });
});
