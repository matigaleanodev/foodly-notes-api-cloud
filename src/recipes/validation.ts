import { Ajv } from 'ajv';
import { routes } from '../http/routes.ts';
import type { IngredientsRequest } from '../contracts/ingredients.ts';
import type { RecipeLangQuery, SearchRecipesQuery, RecipePath } from '../contracts/recipes.ts';
import type { HttpEvent } from '../http/middleware.ts';
import { HttpError } from '../http/middleware.ts';

const ajv = new Ajv({ allErrors: true });
const validateLangQuery = ajv.compile<RecipeLangQuery>(routes.daily.request.query);
const validateSearchQuery = ajv.compile<SearchRecipesQuery>(routes.search.request.query);
const validateBody = ajv.compile<IngredientsRequest>(routes.ingredients.request.body);
const validatePath = ajv.compile<RecipePath>(routes.detail.request.path);
const numeric = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export function badInput(message: string) {
  return new HttpError(400, [message], 'Bad Request');
}

export function recipeId(value: unknown): RecipePath['id'] {
  const path = { id: numeric(value) };
  if (!validatePath(path)) throw badInput('id must be a positive safe integer');
  return path.id;
}

export function recipeQuery(
  event: HttpEvent,
  search = false,
): Required<RecipeLangQuery> & Partial<SearchRecipesQuery> {
  const params = new URLSearchParams(event.rawQueryString);
  const values: Record<string, unknown> = Object.fromEntries(params);
  for (const key of params.keys()) {
    const all = params.getAll(key);
    values[key] = all.length === 1 ? all[0] : all;
  }
  if (typeof values.lang === 'string') values.lang = values.lang.trim().toLowerCase();
  if (typeof values.q === 'string') values.q = values.q.trim();
  const validateQuery = search ? validateSearchQuery : validateLangQuery;
  if (!validateQuery(values)) throw badInput('Invalid recipe query');
  return { ...values, lang: values.lang ?? 'en' };
}

export function ingredientsBody(event: HttpEvent) {
  const type = Object.entries(event.headers).find(
    ([key]) => key.toLowerCase() === 'content-type',
  )?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Content-Type must be application/json.');
  const raw = event.body ?? '';
  // Comprobar también el tamaño codificado antes de reservar el buffer decodificado.
  if (event.isBase64Encoded && raw.length > 4 * Math.ceil(16384 / 3))
    throw new HttpError(413, 'Request body too large.', 'Payload Too Large');
  const buffer = Buffer.from(raw, event.isBase64Encoded ? 'base64' : 'utf8');
  if (buffer.byteLength > 16384)
    throw new HttpError(413, 'Request body too large.', 'Payload Too Large');
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON request body.', 'Bad Request');
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if ('sourceIds' in value && Array.isArray(value.sourceIds))
      value.sourceIds = value.sourceIds.map(numeric);
    if ('lang' in value && typeof value.lang === 'string')
      value.lang = value.lang.trim().toLowerCase();
  }
  if (!validateBody(value)) throw badInput('Invalid ingredients request');
  return { ...value, lang: value.lang ?? 'en' };
}
