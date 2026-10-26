import { Ajv } from 'ajv';
import { configuration } from '../runtime/config.ts';
import { database, type Database } from '../runtime/database.ts';
import { http, HttpError, json, type HttpEvent } from '../http/middleware.ts';
import { routes } from '../http/routes.ts';
import { quota } from '../http/quotas.ts';

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

function safeImage(value?: string | null) {
  if (!value) return undefined;
  if (/^[a-zA-Z0-9][\w.-]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* Imagen ausente si no es un nombre simple o una URL segura. */
  }
  return undefined;
}

export function createRecipesHandler(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const config = configuration(env);
  return http(routes.recipes, config, async (event, context) => {
    const duration = Math.max(1, Math.min(8000, context.getRemainingTimeInMillis() - 500));
    const signal = AbortSignal.timeout(duration);
    try {
      const headers = await quota(db, event.requestContext.http.sourceIp, config, signal);
      const { limit, after } = storedQuery(event);
      const recipes = await db.list(limit, after, signal);
      return json(
        200,
        recipes.map((recipe) => ({
          sourceId: recipe.sourceId,
          title: recipe.base.title,
          image: safeImage(recipe.meta?.image),
        })),
        headers,
      );
    } catch (error) {
      if (signal.aborted)
        throw new HttpError(503, 'Service busy. Retry later.', 'Service Unavailable', {
          'retry-after': '5',
        });
      throw error;
    }
  });
}

const db = database(() => process.env.MONGO_URI);
export const handler = createRecipesHandler(db);
