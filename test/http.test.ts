import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthHandler } from '../src/health/handler.ts';
import {
  createRecipeHandler,
  createRecipeGroupHandler,
  storedQuery,
} from '../src/recipes/handler.ts';
import { createRecipesHandler } from './gateway.ts';
import { configuration } from '../src/runtime/config.ts';
import { tracker } from '../src/http/quotas.ts';
import { database } from '../src/runtime/database.ts';
import { routes } from '../src/http/routes.ts';
import { context, env, event } from './helpers.ts';

describe('Contratos HTTP locales', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('health valida configuración y Mongo sin cuotas ni proveedores y HEAD omite body', async () => {
    const handler = createHealthHandler(env, { ping: async () => undefined });
    expect(await handler(event('/api/health'), context)).toMatchObject({
      statusCode: 200,
      body: '[{"name":"configuration","status":"ok"},{"name":"mongo","status":"ok"}]',
      headers: { 'cache-control': 'no-store' },
    });
    expect(await handler(event('/api/health', '', '127.0.0.1', 'HEAD'), context)).toMatchObject({
      statusCode: 200,
      body: '',
    });
  });
  it('errores de handler preservan JSON, no-store y headers de seguridad', async () => {
    const response = await createHealthHandler({ ...env, NODE_ENV: 'production' })(
      event('/api/other'),
      context,
    );
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body!)).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(response.headers).toMatchObject({
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
    });
  });
  it('rechaza URL excesiva sin consultar persistencia', async () => {
    const response = await createHealthHandler(env)(
      event('/api/health', 'q=' + 'x'.repeat(4096)),
      context,
    );
    expect(response.statusCode).toBe(414);
  });
  it('no registra headers, IP, consultas ni secretos', async () => {
    const request = event('/api/health', 'private=value');
    request.headers.authorization = 'secret';
    await createHealthHandler(env)(request, context);
    const entry = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'requestId', 'route', 'statusCode']);
    expect(JSON.stringify(entry)).not.toMatch(/secret|private|198\.51/);
  });
  it('listado falla cerrado con 503 y Retry-After si falta configuración DB', async () => {
    const db = database(() => undefined);
    const response = await createRecipesHandler(db, env)(event(), context);
    expect(response).toMatchObject({
      statusCode: 503,
      headers: { 'retry-after': '5' },
    });
    expect(response.body).not.toMatch(/MONGO_URI|mongoose/);
  });
  it('rechaza metadata de IP inválida aunque el cliente envíe forwarding headers', async () => {
    const request = event('/api/health', '', 'invalid');
    request.headers['x-forwarded-for'] = '127.0.0.1';
    expect((await createHealthHandler(env)(request, context)).statusCode).toBe(403);
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=true',
    'limit=',
    'limit=1e2',
    'after=-1',
    'after=9007199254740992',
    'after=0',
    'limit=1&limit=2',
    'lang=en',
    '__proto__=x',
  ])('rechaza parámetros inválidos: %s', (query) => {
    expect(() => storedQuery(event('/api/recipes', query))).toThrow();
  });
  it('acepta defaults y enteros decimales con ceros iniciales como el DTO original', () => {
    expect(storedQuery(event())).toEqual({ limit: 50 });
    expect(storedQuery(event('/api/recipes', 'limit=020&after=42'))).toEqual({
      limit: 20,
      after: 42,
    });
  });
  it('normaliza IPv4 mapped y comparte /64 para IPv6 como el limitador original', () => {
    expect(tracker('::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(tracker('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(tracker('2001:db8:abcd:12::2')).toBe(tracker('2001:db8:abcd:12::1'));
    expect(tracker('::1')).toBe('::1');
  });
  it('valida CORS y límites sin defaults permisivos en producción', () => {
    expect(() => configuration({ NODE_ENV: 'production' })).toThrow();
    expect(() => configuration({ ...env, CORS_ORIGIN: '*' })).toThrow();
    expect(() => configuration({ ...env, RATE_LIMIT_GLOBAL: '-1' })).toThrow();
    expect(configuration({ ...env, RATE_LIMIT_GLOBAL: '10' }).globalLimit).toBe(10);
  });
  it('cada grupo rechaza rutas de otros grupos antes de consultar persistencia', async () => {
    const db = database(() => undefined);
    const requests = [
      { group: 'catalog', path: '/api/recipes/7' },
      { group: 'detail', path: '/api/recipes/daily' },
      { group: 'ingredients', path: '/api/recipes/search' },
    ] as const;
    for (const { group, path } of requests) {
      expect(
        (await createRecipeGroupHandler(group, db, env)(event(path), context)).statusCode,
      ).toBe(404);
    }
  });
  it('un handler fijo rechaza eventos de otra integración sin enrutar por la URL', async () => {
    const fixed = createRecipeHandler(
      routes.detail,
      database(() => undefined),
      env,
    );
    expect((await fixed(event('/api/recipes/daily'), context)).statusCode).toBe(404);
  });
});
