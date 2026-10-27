import type { Context } from 'aws-lambda';
import { Ajv } from 'ajv';
import { runtimeEnvironment } from '../runtime/secrets.ts';
import { configuration } from '../runtime/config.ts';
import { database, type Database } from '../runtime/database.ts';
import { http, HttpError, json, type HttpEvent, type HttpResult } from '../http/middleware.ts';
import { routesFor, methodsFor, type RecipeGroup, type RecipeRoute } from '../http/routes.ts';
import { quota } from '../http/quotas.ts';
import { providers, busy, type Providers } from './providers/client.ts';
import { recipeService } from './service.ts';
import { mapStoredRecipeSummary } from './mapper.ts';
import { ingredientsBody, recipeId, recipeQuery } from './validation.ts';

interface StoredQuery {
  limit: number;
  after?: number;
}
const validate = new Ajv({ allErrors: true }).compile<StoredQuery>({
  type: 'object',
  additionalProperties: false,
  required: ['limit'],
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    after: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
});

export function storedQuery(event: HttpEvent): StoredQuery {
  const params = new URLSearchParams(event.rawQueryString);
  const values: Record<string, unknown> = Object.fromEntries(params);
  for (const key of params.keys()) {
    const all = params.getAll(key);
    const value = all[0]!;
    values[key] =
      all.length === 1 && /^\d+$/.test(value) ? Number(value) : all.length === 1 ? value : all;
  }
  values.limit ??= 50;
  if (!validate(values)) {
    const messages = validate.errors!.map((error) =>
      error.keyword === 'additionalProperties'
        ? `property ${String(error.params.additionalProperty)} should not exist`
        : `${error.instancePath.slice(1) || 'query'} ${error.message}`,
    );
    throw new HttpError(400, messages, 'Bad Request');
  }
  return values;
}

export const REQUEST_BUDGET_MS = 27000;

/** Aplica middleware y límites a una operación; el grupo recibe solo sus rutas declaradas. */
export function createRecipeHandler(
  route: RecipeRoute,
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  provider: Providers = providers(db, env),
) {
  const config = configuration(env);
  const service = recipeService(db, provider);
  return http(route, config, async (event: HttpEvent, context: Context): Promise<HttpResult> => {
    const controller = new AbortController();
    const { signal } = controller;
    const duration = Math.max(
      1,
      Math.min(REQUEST_BUDGET_MS, context.getRemainingTimeInMillis() - 750),
    );
    const timer = setTimeout(() => controller.abort(), duration);
    timer.unref();
    let abort: () => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(busy());
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const work = async () => {
        const body = route.operation === 'getIngredients' ? ingredientsBody(event) : undefined;
        const headers = await quota(db, event.requestContext.http.sourceIp, config, signal, route);
        let result: unknown;
        switch (route.operation) {
          case 'getAllRecipes': {
            const { limit, after } = storedQuery(event);
            result = (await db.list(limit, after, signal)).map(mapStoredRecipeSummary);
            break;
          }
          case 'getIngredients':
            result = await service.ingredients(body!.sourceIds, body!.lang, signal);
            break;
          default: {
            const query = recipeQuery(event, route.operation === 'searchRecipes');
            if (route.operation === 'getDailyRecipes')
              result = await service.daily(query.lang, signal);
            else if (route.operation === 'searchRecipes')
              result = await service.search(query.q!, query.lang, signal);
            else {
              const id = recipeId(event.pathParameters?.id);
              result =
                route.operation === 'getRecipeDetails'
                  ? await service.detail(id, query.lang, signal)
                  : await service.similar(id, query.lang, signal);
            }
          }
        }
        signal.throwIfAborted();
        return json(route.method === 'POST' ? 201 : 200, result, headers);
      };
      return await Promise.race([work(), deadline]);
    } catch (error) {
      if (signal.aborted) throw busy();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  });
}

// La misma declaración alimenta CDK y la selección acotada de operaciones dentro del grupo.
export function createRecipeGroupHandler(
  group: RecipeGroup,
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  provider: Providers = providers(db, env),
) {
  const allowed = routesFor(group);
  const handlers = new Map<string, ReturnType<typeof createRecipeHandler>>();
  for (const route of allowed) {
    const handler = createRecipeHandler(route, db, env, provider);
    for (const method of methodsFor(route)) handlers.set(`${method} ${route.path}`, handler);
  }
  const reject = handlers.values().next().value!;
  return (event: HttpEvent, context: Context) =>
    (handlers.get(event.routeKey) ?? reject)(event, context);
}

const runtimeEnv = { ...process.env };
const ready = runtimeEnvironment(runtimeEnv);
const db = database(async () => {
  const loaded = await ready();
  Object.assign(runtimeEnv, loaded);
  return loaded.MONGO_URI;
});

export const catalog = createRecipeGroupHandler('catalog', db, runtimeEnv);

export const detail = createRecipeGroupHandler('detail', db, runtimeEnv);

export const ingredients = createRecipeGroupHandler('ingredients', db, runtimeEnv);
