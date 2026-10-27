import { type JsonHttpClient } from '../src/runtime/http-client.ts';
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
    recipesByIds: async (ids: number[]) => ids.flatMap((id) => recipes.get(id) ?? []),
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
  const transport = vi.fn<JsonHttpClient>(async (input, init) => {
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
        : url.pathname.endsWith('/informationBulk')
          ? url.searchParams
              .get('ids')!
              .split(',')
              .map((value) => ({
                id: Number(value),
                title: `Recipe ${value}`,
                summary: '',
                extendedIngredients: [],
                analyzedInstructions: [],
              }))
          : {
              id,
              title: `Recipe ${id}`,
              summary: '',
              extendedIngredients: [],
              analyzedInstructions: [],
            };
      return data;
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
  it('20 recetas sin caché en español completan en 2 s simulados con dos llamadas de 1 s', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = simulatedDatabase();
    const { transport, metrics } = delayedTransport(1000);
    const handler = createRecipesHandler(db, localEnv, providers(db, localEnv, transport));
    const started = Date.now();
    const pending = handler(ingredients(), { ...context, getRemainingTimeInMillis: () => 29000 });
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(Date.now() - started).toBe(2000);
    expect(JSON.parse(response.body!)).toHaveLength(20);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(metrics()).toEqual({ active: 0, maxActive: 1, cancelled: 0 });
  });
  it('el extremo de 4,999 s completa las 20 recetas traducidas en 9,998 s simulados', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = simulatedDatabase();
    const { transport, metrics } = delayedTransport(4999);
    const handler = createRecipesHandler(db, localEnv, providers(db, localEnv, transport));
    const pending = handler(ingredients(), { ...context, getRemainingTimeInMillis: () => 29000 });
    await vi.advanceTimersByTimeAsync(9998);
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body!).map((recipe: { title: string }) => recipe.title)).toEqual(
      Array.from({ length: 20 }, (_, i) => `es:Recipe ${i + 1}`),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(metrics()).toEqual({ active: 0, maxActive: 1, cancelled: 0 });
  });
  it('conserva cancelación a 27 s si la persistencia no termina y no inicia proveedor', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const db = {
      ...simulatedDatabase(),
      recipesByIds: async () => new Promise<StoredRecipe[]>(() => undefined),
    };
    const { transport } = delayedTransport(4999);
    const handler = createRecipesHandler(db, localEnv, providers(db, localEnv, transport));
    const pending = handler(ingredients(), { ...context, getRemainingTimeInMillis: () => 29000 });
    await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS);
    expect(await pending).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
    expect(transport).not.toHaveBeenCalled();
  });
  it('una llamada de 6 s ahora completa y consume la misma unidad de presupuesto', async () => {
    vi.useFakeTimers();
    const db = simulatedDatabase();
    const reserve = vi.spyOn(db, 'reserve');
    const { transport, metrics } = delayedTransport(6000);
    const api = providers(db, localEnv, transport);
    const pending = api.detail(1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toMatchObject({ id: 1 });
    expect(metrics()).toEqual({ active: 0, maxActive: 1, cancelled: 0 });
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it.each([
    { remaining: 29000, duration: 27000 },
    { remaining: 2000, duration: 1250 },
  ])(
    'el deadline efectivo $duration cancela proveedores y libera slots sin reembolsar budgets',
    async ({ remaining, duration }) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const db = simulatedDatabase();
      const reserve = vi.spyOn(db, 'reserve');
      const { transport, metrics } = delayedTransport(60000);
      const api = providers(db, { ...localEnv, PROVIDER_MAX_CONCURRENCY: '1' }, transport);
      const handler = createRecipesHandler(db, localEnv, api);
      const pending = handler(ingredients([1]), {
        ...context,
        getRemainingTimeInMillis: () => remaining,
      });
      await vi.advanceTimersByTimeAsync(duration);
      expect(await pending).toMatchObject({ statusCode: 503, headers: { 'retry-after': '5' } });
      expect(metrics()).toEqual({ active: 0, maxActive: 1, cancelled: 1 });
      const controller = new AbortController();
      const next = expect(api.detail(2, controller.signal)).rejects.toMatchObject({
        statusCode: 502,
      });
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await next;
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(metrics().active).toBe(0);
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );
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
