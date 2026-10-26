import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from '../src/runtime/database.ts';
import { REQUEST_BUDGET_MS } from '../src/recipes/handler.ts';
import { createRecipesHandler } from './gateway.ts';
import { providers, providerAccess } from '../src/recipes/providers/client.ts';
import { context, env, event } from './helpers.ts';
import type { StoredRecipe, TranslationEntry } from '../src/recipes/models.ts';

const localEnv = {
  ...env,
  SPOONACULAR_BASE_URL: 'https://spoon.invalid',
  SPOONACULAR_API_KEY: 'fixture',
  AZURE_TRANSLATOR_KEY: 'fixture',
  AZURE_TRANSLATOR_REGION: 'fixture',
};

function ingredients(ids = Array.from({ length: 20 }, (_, i) => i + 1)) {
  const request = event('/api/recipes/ingredients', '', '127.0.0.1', 'POST');
  request.headers['content-type'] = 'application/json';
  request.body = JSON.stringify({ sourceIds: ids, lang: 'es' });
  return request;
}

// El reloj virtual mide la orquestación y cancelación; latencias Mongo/red reales quedan para etapa 4.
function simulatedDatabase() {
  const recipes = new Map<number, StoredRecipe>();
  const entries = new Map<string, TranslationEntry>();
  return {
    ...database(() => undefined),
    increment: async () => 1,
    reserve: async () => true,
    recipe: async (id: number) => recipes.get(id) ?? null,
    insertRecipe: async (value: Pick<StoredRecipe, 'sourceId' | 'base' | 'meta'>) => {
      const stored = { ...value, source: 'spoonacular', originalLang: 'en', translations: {} };
      recipes.set(value.sourceId, stored);
      return stored;
    },
    translations: async (texts: string[], target: string) =>
      texts.flatMap((text) => entries.get(`${target}:${text}`) ?? []),
    insertTranslation: async (value: TranslationEntry) => {
      entries.set(`${value.targetLang}:${value.sourceText}`, value);
    },
    saveSpanish: async (id: number, value: StoredRecipe['translations'][string]) => {
      const stored = recipes.get(id)!;
      stored.translations.es = value;
      return stored;
    },
  };
}

function delayedTransport(delay: number) {
  let active = 0;
  let maxActive = 0;
  let cancelled = 0;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          cancelled++;
          reject(new Error('cancelled'));
        };
        const timer = setTimeout(() => {
          init?.signal?.removeEventListener('abort', abort);
          resolve();
        }, delay);
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
      const url = new URL(String(input));
      const id = Number(/recipes\/(\d+)/.exec(url.pathname)?.[1]);
      const data = url.hostname.includes('microsofttranslator')
        ? (JSON.parse(String(init?.body)) as { text: string }[]).map(({ text }) => ({
            translations: [{ text: `es:${text}` }],
          }))
        : {
            id,
            title: `Recipe ${id}`,
            summary: '',
            extendedIngredients: [],
            analyzedInstructions: [],
          };
      return new Response(JSON.stringify(data));
    } finally {
      active--;
    }
  });
  return { transport, metrics: () => ({ active, maxActive, cancelled }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('Riesgo síncrono y límites de proveedores simulados', () => {
  it('20 recetas sin caché en español completan en 10 s simulados con proveedores de 1 s y máximo cuatro llamadas', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = simulatedDatabase();
    const { transport, metrics } = delayedTransport(1000);
    const handler = createRecipesHandler(db, localEnv, providers(db, localEnv, transport));
    const started = Date.now();
    const pending = handler(ingredients(), { ...context, getRemainingTimeInMillis: () => 29000 });
    await vi.advanceTimersByTimeAsync(10000);
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(Date.now() - started).toBe(10000);
    expect(JSON.parse(response.body!)).toHaveLength(20);
    expect(transport).toHaveBeenCalledTimes(40);
    expect(metrics()).toEqual({ active: 0, maxActive: 4, cancelled: 0 });
  });
  it('el extremo de 4,999 s por llamada requiere casi 50 s: corta a 27 s con 503, cancela y no inicia más tandas', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = simulatedDatabase();
    const { transport, metrics } = delayedTransport(4999);
    const handler = createRecipesHandler(db, localEnv, providers(db, localEnv, transport));
    const pending = handler(ingredients(), { ...context, getRemainingTimeInMillis: () => 29000 });
    await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS);
    expect(await pending).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    expect(metrics()).toMatchObject({ active: 0, maxActive: 4, cancelled: 4 });
    const calls = transport.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(calls).toBeLessThan(40);
  });
  it('el timeout de cada proveedor a 5 s no reintenta y libera la concurrencia', async () => {
    vi.useFakeTimers();
    const db = simulatedDatabase();
    const { transport, metrics } = delayedTransport(6000);
    const api = providers(db, localEnv, transport);
    const pending = expect(api.detail(1, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 502,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(metrics()).toEqual({ active: 0, maxActive: 1, cancelled: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rechaza saturación por instancia antes de consumir presupuesto', async () => {
    const db = simulatedDatabase();
    const reserve = vi.spyOn(db, 'reserve');
    const access = providerAccess(db, {});
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Array.from({ length: 4 }, () =>
      access('spoonacular', 1, new AbortController().signal, () => waiting),
    );
    await expect(
      access('spoonacular', 1, new AbortController().signal, async () => undefined),
    ).rejects.toMatchObject({ statusCode: 503 });
    release();
    await Promise.all(running);
    expect(reserve).toHaveBeenCalledTimes(4);
  });
});
