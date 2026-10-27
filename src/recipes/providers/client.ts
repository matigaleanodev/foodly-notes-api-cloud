import { Ajv } from 'ajv';
import type { Database } from '../../runtime/database.ts';
import { HttpError } from '../../http/middleware.ts';
import type { Lang } from '../models.ts';
import type { SpoonacularRecipeDetail, SpoonacularRandomRecipe } from './types.ts';

export interface Providers {
  detail(id: number, signal: AbortSignal): Promise<SpoonacularRecipeDetail>;
  details(ids: number[], signal: AbortSignal): Promise<SpoonacularRecipeDetail[]>;
  daily(signal: AbortSignal): Promise<SpoonacularRandomRecipe[]>;
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ id: number; title: string; image: string | null }[]>;
  similar(
    id: number,
    signal: AbortSignal,
  ): Promise<{ sourceId: number; title: string; image: string | null }[]>;
  translate(texts: string[], target: Lang, signal: AbortSignal): Promise<string[]>;
}

export function positiveSetting(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new Error('Invalid provider limit.');
  return Number(value);
}

export function busy(message = 'Service busy. Retry later.', retry = 5) {
  return new HttpError(503, message, 'Service Unavailable', { 'retry-after': String(retry) });
}

/** Reserva presupuesto UTC antes de llamar al proveedor; los intentos fallidos también consumen. */
export function providerAccess(db: Database, env: NodeJS.ProcessEnv) {
  let active = 0;
  const concurrency = Math.min(4, positiveSetting(env.PROVIDER_MAX_CONCURRENCY, 4));
  const limits = {
    spoonacular: positiveSetting(env.SPOONACULAR_DAILY_REQUEST_LIMIT, 100),
    azure: positiveSetting(env.AZURE_DAILY_CHARACTER_LIMIT, 50000),
  };
  return async <T>(
    provider: keyof typeof limits,
    units: number,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    if (active >= concurrency) throw busy();
    active++;
    try {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const tomorrow = Date.parse(day) + 86400000;
      const exhausted = () =>
        busy(
          'Provider daily budget exhausted. Retry later.',
          Math.max(1, Math.ceil((tomorrow - now) / 1000)),
        );
      if (!Number.isSafeInteger(units) || units < 1 || units > limits[provider]) throw exhausted();
      let reserved: boolean;
      try {
        reserved = await db.reserve(
          `budget:${provider}:${day}`,
          units,
          limits[provider],
          new Date(tomorrow + 86400000),
          signal,
        );
      } catch {
        throw busy('Provider budget verification unavailable.');
      }
      if (!reserved) throw exhausted();
      signal.throwIfAborted();
      return await work();
    } finally {
      active--;
    }
  };
}

const ajv = new Ajv();
const summary = {
  type: 'object',
  required: ['id', 'title'],
  properties: {
    id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    title: { type: 'string' },
  },
};
const validSummaries = ajv.compile<SpoonacularRandomRecipe[]>({ type: 'array', items: summary });
const validDetail = ajv.compile<SpoonacularRecipeDetail>({
  ...summary,
  required: ['id', 'title', 'analyzedInstructions', 'extendedIngredients'],
  properties: {
    ...summary.properties,
    summary: { type: 'string', nullable: true },
    analyzedInstructions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['steps'],
        properties: {
          name: { type: 'string', nullable: true },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['number', 'step'],
              properties: { number: { type: 'number' }, step: { type: 'string' } },
            },
          },
        },
      },
    },
    extendedIngredients: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'original', 'amount', 'unit'],
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          original: { type: 'string' },
          amount: { type: 'number' },
          unit: { type: 'string' },
        },
      },
    },
  },
});

/** Encapsula HTTP y mapeos externos; el transporte inyectable permite probar sin llamadas reales. */
export function providers(
  db: Database,
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): Providers {
  const access = providerAccess(db, env);
  const enabled = () => {
    if (env.NODE_ENV === 'production' && env.REAL_PROVIDERS_ENABLED !== 'true')
      throw busy('External providers disabled.');
  };
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error('Missing provider configuration.');
    return value;
  };
  const https = (value: string) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid provider URL.');
    return url.href.replace(/\/+$/, '');
  };
  const request = async (url: URL, init: RequestInit, parent: AbortSignal) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(5000), controller.signal]);
    const body = init.body;
    if (typeof body === 'string' && Buffer.byteLength(body) > 256 * 1024)
      throw new Error('Provider request too large.');
    try {
      const response = await transport(url, { ...init, signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new HttpError(404, 'Recipe not found.', 'Not Found');
        throw new Error('Provider HTTP failure.');
      }
      if (Number(response.headers.get('content-length')) > 1024 * 1024)
        throw new Error('Provider response too large.');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty provider response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error('Provider response too large.');
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      controller.abort();
    }
  };
  const spoon = async (
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    units = 1,
  ) => {
    try {
      enabled();
      return await access('spoonacular', units, signal, () => {
        const url = new URL(`${https(required('SPOONACULAR_BASE_URL'))}/recipes/${path}`);
        url.search = new URLSearchParams({
          ...params,
          apiKey: required('SPOONACULAR_API_KEY'),
        }).toString();
        return request(url, {}, signal);
      });
    } catch (error) {
      if (error instanceof HttpError && [404, 503].includes(error.statusCode)) throw error;
      throw new HttpError(502, 'Recipe provider unavailable.', 'Bad Gateway');
    }
  };
  const summaries = (value: unknown) => {
    if (!validSummaries(value))
      throw new HttpError(502, 'Recipe provider unavailable.', 'Bad Gateway');
    return value;
  };
  const image = (r: SpoonacularRandomRecipe & { imageType?: string }) =>
    r.imageType ? `https://img.spoonacular.com/recipes/${r.id}-556x370.${r.imageType}` : null;
  return {
    async detail(id, signal) {
      const value = await spoon(`${id}/information`, {}, signal);
      if (!validDetail(value) || value.id !== id)
        throw new HttpError(502, 'Recipe provider unavailable.', 'Bad Gateway');
      return value;
    },

    async details(ids, signal) {
      if (!ids.length) return [];
      // El lote conserva la reserva anterior por receta, sin ampliar el presupuesto diario.
      const value = await spoon('informationBulk', { ids: ids.join(',') }, signal, ids.length);
      if (
        !Array.isArray(value) ||
        !value.every((item): item is SpoonacularRecipeDetail => validDetail(item)) ||
        new Set(value.map((item) => item.id)).size !== value.length ||
        value.some((item) => !ids.includes(item.id))
      )
        throw new HttpError(502, 'Recipe provider unavailable.', 'Bad Gateway');
      if (value.length !== ids.length) throw new HttpError(404, 'Recipe not found.', 'Not Found');
      const byId = new Map(value.map((item) => [item.id, item]));
      return ids.map((id) => byId.get(id)!);
    },

    async daily(signal) {
      const value = await spoon('random', { number: '12', addRecipeInformation: 'true' }, signal);
      return summaries((value as { recipes?: unknown })?.recipes).slice(0, 12);
    },

    async search(query, signal) {
      const value = await spoon(
        'complexSearch',
        { query, number: '12', addRecipeInformation: 'true' },
        signal,
      );
      return summaries((value as { results?: unknown })?.results)
        .slice(0, 12)
        .map((r) => ({ id: r.id, title: r.title, image: image(r) }));
    },

    async similar(id, signal) {
      const value = await spoon(`${id}/similar`, { number: '6' }, signal);
      return summaries(value)
        .slice(0, 6)
        .map((r) => ({ sourceId: r.id, title: r.title, image: image(r) }));
    },

    async translate(texts, target, signal) {
      enabled();
      const concurrency = Math.min(4, positiveSetting(env.PROVIDER_MAX_CONCURRENCY, 4));
      const batches = Array.from({ length: Math.ceil(texts.length / 100) }, (_, i) =>
        texts.slice(i * 100, (i + 1) * 100),
      );
      const translateBatch = async (batch: string[]) => {
        const characters = batch.reduce((sum, text) => sum + text.length, 0);
        if (characters > 50000)
          throw new HttpError(502, 'Translation input exceeds provider limits.', 'Bad Gateway');
        try {
          const value = await access('azure', Math.max(1, characters), signal, () => {
            const url = new URL(
              env.AZURE_TRANSLATOR_ENDPOINT?.trim()
                ? `${https(env.AZURE_TRANSLATOR_ENDPOINT)}/translate`
                : 'https://api.cognitive.microsofttranslator.com/translate',
            );
            url.search = new URLSearchParams({ 'api-version': '3.0', to: target }).toString();
            return request(
              url,
              {
                method: 'POST',
                body: JSON.stringify(batch.map((text) => ({ text }))),
                headers: {
                  'Ocp-Apim-Subscription-Key': required('AZURE_TRANSLATOR_KEY'),
                  'Ocp-Apim-Subscription-Region': required('AZURE_TRANSLATOR_REGION'),
                  'Content-Type': 'application/json',
                },
              },
              signal,
            );
          });
          if (
            !Array.isArray(value) ||
            value.length !== batch.length ||
            value.some((item) => typeof item?.translations?.[0]?.text !== 'string')
          )
            throw new Error('Invalid translation response.');
          return value.map((item) => item.translations[0].text as string);
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 503) throw error;
          throw new HttpError(502, 'Translation provider unavailable.', 'Bad Gateway');
        }
      };
      const translated: string[] = [];
      for (let offset = 0; offset < batches.length; offset += concurrency) {
        signal.throwIfAborted();
        // Esperar toda la tanda antes de fallar: sin trabajo huérfano ni nuevas llamadas tras error.
        const results = await Promise.allSettled(
          batches.slice(offset, offset + concurrency).map(translateBatch),
        );
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          translated.push(...result.value);
        }
      }
      return translated;
    },
  };
}
