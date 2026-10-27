import type { FromSchema } from 'json-schema-to-ts';

/** Contratos canónicos: el runtime conserva parsing, normalización y defaults. */
export const storedRecipesQuerySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['limit'],
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    after: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
  },
} as const;

export const recipeLangQuerySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {
    lang: { type: 'string', enum: ['en', 'es'] },
  },
} as const;

export const searchRecipesQuerySchema = {
  ...recipeLangQuerySchema,
  required: ['q'],
  properties: {
    ...recipeLangQuerySchema.properties,
    q: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\p{Cc}]*$' },
  },
} as const;

export const recipePathSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  // Solo se valida id; otros parámetros de path siguen ignorados por el runtime.
  additionalProperties: true,
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
  },
} as const;

export type StoredRecipesQuery = FromSchema<typeof storedRecipesQuerySchema>;

export type RecipeLangQuery = FromSchema<typeof recipeLangQuerySchema>;

export type SearchRecipesQuery = FromSchema<typeof searchRecipesQuerySchema>;

export type RecipePath = FromSchema<typeof recipePathSchema>;
