import { Ajv } from 'ajv';
import type { HttpEvent } from '../http/middleware.ts';
import { HttpError } from '../http/middleware.ts';
import type { Lang } from './models.ts';

const ajv = new Ajv({ allErrors: true });
const idSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const langSchema = { type: 'string', enum: ['en', 'es'], nullable: true };
const validateQuery = ajv.compile<{ lang?: Lang; q?: string }>({
  type: 'object',
  additionalProperties: false,
  properties: {
    lang: langSchema,
    q: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\p{Cc}]*$' },
  },
});
const validateBody = ajv.compile<{ sourceIds: number[]; lang?: Lang }>({
  type: 'object',
  additionalProperties: false,
  required: ['sourceIds'],
  properties: {
    sourceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: idSchema },
    lang: langSchema,
  },
});
const validateId = ajv.compile<number>(idSchema);
const numeric = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export function badInput(message: string) {
  return new HttpError(400, [message], 'Bad Request');
}

export function recipeId(value: unknown): number {
  const id = numeric(value);
  if (!validateId(id)) throw badInput('id must be a positive safe integer');
  return id;
}

export function recipeQuery(event: HttpEvent, search = false) {
  const params = new URLSearchParams(event.rawQueryString);
  const values: Record<string, unknown> = Object.fromEntries(params);
  for (const key of params.keys()) {
    const all = params.getAll(key);
    values[key] = all.length === 1 ? all[0] : all;
  }
  if (typeof values.lang === 'string') values.lang = values.lang.trim().toLowerCase();
  if (typeof values.q === 'string') values.q = values.q.trim();
  if (!validateQuery(values) || (search ? values.q === undefined : Object.hasOwn(values, 'q')))
    throw badInput('Invalid recipe query');
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
