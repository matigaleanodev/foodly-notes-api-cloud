import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthHandler } from '../src/health/handler.ts';
import { createRecipeHandler, storedQuery } from '../src/recipes/handler.ts';
import { createRecipesHandler } from './gateway.ts';
import { configuration } from '../src/runtime/config.ts';
import { tracker } from '../src/http/quotas.ts';
import { database } from '../src/runtime/database.ts';
import serverless from '../serverless.ts';
import { routes, recipeRoutes, eventsFor } from '../src/http/routes.ts';
import { context, env, event } from './helpers.ts';

describe('Contratos HTTP locales', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('health responde sin URI Mongo, cuotas ni secretos y HEAD omite body', async () => {
    const handler = createHealthHandler(env);
    expect(await handler(event('/api/health'), context)).toMatchObject({
      statusCode: 200,
      body: '{"status":"ok"}',
      headers: { 'cache-control': 'no-store' },
    });
    expect(await handler(event('/api/health', '', '127.0.0.1', 'HEAD'), context)).toMatchObject({
      statusCode: 200,
      body: '',
    });
  });
  it('configura CORS y preflight en Gateway sin integración OPTIONS ni Lambda', () => {
    expect(serverless.provider.httpApi.cors).toEqual({
      allowedOrigins: ['http://localhost:8100', 'capacitor://localhost'],
      allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept'],
      exposedResponseHeaders: [
        'Retry-After',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ],
      maxAge: 600,
      allowCredentials: false,
    });
    const events = Object.values(serverless.functions).flatMap((fn) => fn.events);
    expect(events.some(({ httpApi }) => String(httpApi.method) === 'OPTIONS')).toBe(false);
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
  it('cada endpoint integra una función con export fijo y sin catch-all ni métodos ANY', () => {
    expect(serverless.functions.health.events).toEqual(eventsFor(routes.health));
    for (const route of recipeRoutes) {
      const fn = serverless.functions[route.handler];
      expect(fn.events).toEqual(eventsFor(route));
      expect(fn.handler).toBe(`recipes.${route.handler}`);
    }
    expect(Object.keys(serverless.functions)).toHaveLength(7);
    const events = Object.values(serverless.functions).flatMap((fn) => fn.events);
    expect(events).toHaveLength(13);
    expect(JSON.stringify(events)).not.toMatch(/proxy|default|ANY/);
    expect(serverless.functions.health).not.toHaveProperty('environment');
    expect(serverless.provider.runtime).toBe('nodejs24.x');
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
