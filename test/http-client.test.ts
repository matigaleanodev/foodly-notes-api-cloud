import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, Agent, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import {
  createJsonHttpClient,
  HTTP_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  type JsonHttpClient,
  type JsonRequest,
} from '../packages/runtime/src/runtime/http-client.ts';
import { database } from '../packages/runtime/src/runtime/database.ts';
import { providers } from '../packages/runtime/src/recipes/providers/client.ts';
import { createRecipesHandler } from './gateway.ts';
import { context, env, event } from './helpers.ts';
import { RequestCancellation } from '../packages/runtime/src/runtime/request-context.ts';

const settings = {
  ...env,
  SPOONACULAR_API_KEY: 'secret-spoon',
  AZURE_TRANSLATOR_KEY: 'secret-azure',
  AZURE_TRANSLATOR_REGION: 'fixture',
};
const request = (signal = new AbortController().signal): JsonRequest => ({
  provider: 'spoonacular',
  operation: 'detail',
  method: 'GET',
  signal,
});

describe('Adaptador Axios real aislado en HTTPS loopback', () => {
  let server: Server;
  let directory: string;
  let base: string;
  let agent: Agent;
  let client: JsonHttpClient;
  let logs: string[];
  const paths: string[] = [];
  const closed = new Set<string>();
  let receivedBytes = 0;
  let status = 200;
  let slow = false;
  let content: unknown = {
    id: 1,
    title: 'Recipe',
    extendedIngredients: [],
    analyzedInstructions: [],
  };
  let responder: ((response: ServerResponse) => void) | undefined;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foodly-axios-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const cert = await readFile(join(directory, 'cert.pem'));
    server = createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      (incoming, response) => {
        const path = new URL(incoming.url!, 'https://localhost').pathname;
        paths.push(path);
        response.on('close', () => closed.add(path));
        incoming.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
        });
        if (path === '/body') {
          incoming.on('end', () => response.end('{}'));
          return;
        }
        if (responder) return responder(response);
        if (path === '/reset') return incoming.socket.destroy();
        if (path === '/wait') return;
        if (path === '/stream') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('[');
          const timer = setInterval(() => response.write(' '), 20);
          response.on('close', () => clearInterval(timer));
          return;
        }
        if (slow) return;
        response.writeHead(status, {
          'content-type': 'application/json',
          'retry-after': '7',
          'set-cookie': 'secret-cookie',
          location: `${base}/redirect-target?token=secret-location`,
        });
        response.end(JSON.stringify(content));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local address');
    base = `https://127.0.0.1:${address.port}`;
    agent = new Agent({ ca: cert, keepAlive: false });
    logs = [];
    client = createJsonHttpClient((line) => logs.push(line), agent);
  });
  afterEach(() => {
    logs.length = 0;
    paths.length = 0;
    closed.clear();
    receivedBytes = 0;
    status = 200;
    slow = false;
    responder = undefined;
    content = { id: 1, title: 'Recipe', extendedIngredients: [], analyzedInstructions: [] };
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    agent?.destroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const url = (path = '/ok') => new URL(`${base}${path}`);
  const store = () => ({
    ...database(() => undefined),
    increment: async () => 1,
    reserve: vi.fn(async () => true),
    recipe: async () => null,
  });
  const provider = (db = store(), http = client) =>
    providers(
      db,
      {
        ...settings,
        SPOONACULAR_BASE_URL: base,
        AZURE_TRANSLATOR_ENDPOINT: base,
      },
      http,
    );

  it('parsea JSON como unknown, envía JSON y acepta exactamente ambos límites', async () => {
    expect(await client(url(), request())).toMatchObject({ id: 1 });
    const body = JSON.stringify('a'.repeat(MAX_REQUEST_BYTES - 2));
    await client(url('/body'), {
      ...request(),
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(receivedBytes).toBe(MAX_REQUEST_BYTES);
    content = 'a'.repeat(MAX_RESPONSE_BYTES - 2);
    expect(await client(url(), request())).toBe(content);
    expect(logs).toEqual([]);
  });
  it('rechaza request mayor a 256 KiB antes de la red', async () => {
    await expect(
      client(url(), { ...request(), method: 'POST', body: 'a'.repeat(MAX_REQUEST_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'REQUEST_SIZE' });
    expect(paths).toEqual([]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ code: 'REQUEST_SIZE' });
  });
  it('Azure respeta bytes JSON escapados y mantiene la reserva aunque no salga a la red', async () => {
    const db = store();
    const api = provider(db);
    await expect(
      api.translate(['\u0000'.repeat(50000)], 'es', request().signal),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(paths).toEqual([]);
    expect(db.reserve).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      provider: 'azure',
      operation: 'translate',
      code: 'REQUEST_SIZE',
      body: { requestBytes: 300013, items: 1, characters: 50000, language: 'es' },
    });
  });
  it.each(['http://127.0.0.1', 'https://user:secret@localhost', 'https://localhost/#secret'])(
    'rechaza destino inválido sin red ni secretos: %s',
    async (destination) => {
      await expect(client(new URL(destination), request())).rejects.toMatchObject({
        code: 'INVALID_URL',
      });
      expect(paths).toEqual([]);
      expect(logs.join('')).not.toContain('secret');
    },
  );
  it.each([301, 302, 307, 308, 404, 429, 502, 503])(
    'HTTP %s no sigue redirects ni reintenta y preserva mapping público',
    async (value) => {
      status = value;
      const api = provider();
      await expect(api.detail(1, request().signal)).rejects.toMatchObject({
        statusCode: value === 404 ? 404 : 502,
      });
      expect(paths).toEqual(['/recipes/1/information']);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        status: value,
        code: 'HTTP_STATUS',
        headers: { retryAfter: '7' },
      });
    },
  );
  it.each(['{', '', '\ufeff{}', '{"secret":"sensitive-text",}'])(
    'rechaza JSON inválido o vacío sin registrar body: %j',
    async (body) => {
      responder = (response) => response.end(body);
      await expect(client(url(), request())).rejects.toMatchObject({ code: 'INVALID_JSON' });
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain('sensitive-text');
    },
  );
  it.each(['declared', 'chunked', 'gzip', 'br'])(
    'limita respuesta %s y cierra el socket',
    async (kind) => {
      responder = (response) => {
        if (kind === 'declared') {
          response.writeHead(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) });
          response.flushHeaders();
        } else if (kind === 'gzip') {
          response.writeHead(200, { 'content-encoding': 'gzip' });
          response.end(gzipSync(JSON.stringify('x'.repeat(MAX_RESPONSE_BYTES))));
        } else if (kind === 'br') {
          response.writeHead(200, { 'content-encoding': 'br' });
          response.end(brotliCompressSync(JSON.stringify('x'.repeat(MAX_RESPONSE_BYTES))));
        } else {
          response.write('"');
          response.end('x'.repeat(MAX_RESPONSE_BYTES));
        }
      };
      await expect(client(url('/size'), request())).rejects.toMatchObject({
        code: 'RESPONSE_SIZE',
      });
      await vi.waitFor(() => expect(closed.has('/size')).toBe(true));
      expect(logs).toHaveLength(1);
    },
  );
  it('404 cierra inmediatamente un body ilimitado sin esperar a leerlo', async () => {
    responder = (response) => {
      response.writeHead(404, { 'content-length': String(MAX_RESPONSE_BYTES * 2) });
      response.flushHeaders();
    };
    await expect(provider().detail(1, request().signal)).rejects.toMatchObject({ statusCode: 404 });
    await vi.waitFor(() => expect(closed.has('/recipes/1/information')).toBe(true));
  });
  it('un reset de red no reintenta y devuelve error tipado sin mensaje interno', async () => {
    await expect(client(url('/reset'), request())).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'External HTTP request failed.',
    });
    expect(paths).toEqual(['/reset']);
    expect(logs).toHaveLength(1);
  });
  it('cancelación durante streaming destruye la conexión y conserva la causa segura', async () => {
    const controller = new AbortController();
    const pending = expect(
      client(url('/stream'), request(controller.signal)),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(paths).toContain('/stream'));
    controller.abort(new RequestCancellation('lambda_margin'));
    await pending;
    await vi.waitFor(() => expect(closed.has('/stream')).toBe(true));
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: 200, cancellation: 'lambda_margin' });
  });
  it('una respuesta real de 6 s supera el timeout anterior y completa sin reintento', async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    responder = (response) => {
      timer = setTimeout(() => response.end('{"ok":true}'), 6000);
      response.on('close', () => clearTimeout(timer));
    };
    const started = performance.now();
    expect(await client(url('/slow-success'), request())).toEqual({ ok: true });
    expect(performance.now() - started).toBeGreaterThanOrEqual(5900);
    expect(paths).toEqual(['/slow-success']);
    expect(logs).toEqual([]);
  }, 10000);
  it('una señal ya cancelada no envía nada y no registra su motivo arbitrario', async () => {
    const controller = new AbortController();
    controller.abort(new Error('secret-cancellation'));
    await expect(client(url(), request(controller.signal))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(paths).toEqual([]);
    expect(logs.join('')).not.toContain('secret-cancellation');
  });
  it('correlaciona errores con x-request-id y omite secretos, IP, query, paths, headers y bodies', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    status = 503;
    content = { text: 'secret-response', token: 'secret-token' };
    const db = store();
    const handler = createRecipesHandler(db, settings, provider(db));
    const response = await handler(
      event('/api/recipes/search', 'q=secret-search&lang=en'),
      context,
    );
    expect(response.statusCode).toBe(502);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      requestId: response.headers?.['x-request-id'],
      provider: 'spoonacular',
      operation: 'search',
      method: 'GET',
      destination: 'https://[redacted]',
      status: 503,
      code: 'HTTP_STATUS',
      durationMs: expect.any(Number),
      parameters: { number: '12', addRecipeInformation: 'true' },
    });
    await expect(
      client(
        url('/secret-path?apiKey=secret-key&query=secret-query&token=secret-token&number=12'),
        {
          ...request(),
          provider: 'azure',
          operation: 'translate',
          method: 'POST',
          headers: {
            Authorization: 'secret-auth',
            Cookie: 'secret-cookie',
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': 'secret-subscription',
          },
          body: JSON.stringify([{ text: 'secret-translation' }]),
          summary: { items: 1, characters: 18, language: 'es' },
        },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_STATUS' });
    expect(logs).toHaveLength(2);
    const output = logs.join('');
    expect(output).not.toMatch(
      /secret-|127\.0\.0\.1|198\.51\.100\.10|Authorization|Cookie|Subscription|config|stack/,
    );
    expect(logs.every((line) => Buffer.byteLength(line) <= 2048)).toBe(true);
    expect(JSON.parse(logs[1]!)).toMatchObject({
      body: { items: 1, characters: 18, language: 'es' },
    });
  });
  it('dos requests simultáneas mantienen correlación independiente', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    status = 503;
    const db = store();
    const handler = createRecipesHandler(db, settings, provider(db));
    const responses = await Promise.all([
      handler(event('/api/recipes/1'), context),
      handler(event('/api/recipes/2'), context),
    ]);
    const ids = responses.map((response) => response.headers?.['x-request-id']);
    expect(new Set(ids).size).toBe(2);
    expect(logs).toHaveLength(2);
    expect(logs.map((line) => JSON.parse(line).requestId).sort()).toEqual(ids.sort());
  });
  it('un logger que falla no rompe el fallback de traducción ni cambia presupuestos', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = {
      ...store(),
      translations: async () => [],
      insertTranslation: async () => undefined,
    };
    const throwing = createJsonHttpClient(() => {
      throw new Error('logger failed');
    }, agent);
    // Azure falla; Spoonacular todavía devuelve el resultado base de búsqueda.
    responder = (response) => {
      if (paths.at(-1) === '/translate') {
        response.writeHead(503);
        response.end('secret-response');
      } else response.end(JSON.stringify({ results: [{ id: 1, title: 'Base' }] }));
    };
    const handler = createRecipesHandler(db, settings, provider(db, throwing));
    const response = await handler(event('/api/recipes/search', 'q=arroz&lang=es'), context);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual([{ sourceId: 1, title: 'Base', image: null }]);
    expect(db.reserve).toHaveBeenCalledTimes(2);
    expect(paths).toEqual(['/translate', '/recipes/complexSearch']);
  });
  it('el margen Lambda cancela red real, libera concurrencia y no devuelve el presupuesto reservado', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    slow = true;
    const db = store();
    const api = providers(
      db,
      { ...settings, SPOONACULAR_BASE_URL: base, PROVIDER_MAX_CONCURRENCY: '1' },
      client,
    );
    const handler = createRecipesHandler(db, settings, api);
    const response = await handler(event('/api/recipes/1'), {
      ...context,
      getRemainingTimeInMillis: () => 950,
    });
    expect(response).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    await vi.waitFor(() => expect(closed.has('/recipes/1/information')).toBe(true));
    expect(JSON.parse(logs[0]!)).toMatchObject({
      cancellation: 'lambda_margin',
      requestId: response.headers?.['x-request-id'],
    });
    slow = false;
    content = { id: 2, title: 'Recipe', extendedIngredients: [], analyzedInstructions: [] };
    expect(await api.detail(2, request().signal)).toMatchObject({ id: 2 });
    expect(db.reserve).toHaveBeenCalledTimes(2);
  });
  it('30.000 ms cancelan Axios incluso con streaming; el deadline global real corta a 27 s antes', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    slow = true;
    const db = store();
    const handler = createRecipesHandler(db, settings, provider(db));
    const started = performance.now();
    const global = handler(event('/api/recipes/1'), {
      ...context,
      getRemainingTimeInMillis: () => 29000,
    });
    const timeout = expect(client(url('/stream'), request())).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    const idleTimeout = expect(client(url('/wait'), request())).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    const response = await global;
    const duration = performance.now() - started;
    expect(response).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    expect(duration).toBeGreaterThanOrEqual(26500);
    expect(duration).toBeLessThan(HTTP_TIMEOUT_MS);
    await vi.waitFor(() => expect(closed.has('/recipes/1/information')).toBe(true));
    await Promise.all([timeout, idleTimeout]);
    await vi.waitFor(() => expect(closed.has('/stream') && closed.has('/wait')).toBe(true));
    expect(logs).toHaveLength(3);
    expect(logs.map((line) => JSON.parse(line).cancellation).sort()).toEqual([
      'axios_timeout',
      'axios_timeout',
      'deadline',
    ]);
    expect(db.reserve).toHaveBeenCalledTimes(1);
  }, 40000);
});
