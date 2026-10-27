import type { FromSchema } from 'json-schema-to-ts';

const dialect = 'http://json-schema.org/draft-07/schema#';
const sourceId = { type: 'integer', minimum: 1, maximum: 9007199254740991 } as const;

// Listado/daily/similares omiten imágenes inválidas; búsqueda emite null.
export const recipeSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'title'],
  properties: { sourceId, title: { type: 'string' }, image: { type: 'string' } },
} as const;

export const storedRecipesResponseSchema = {
  $schema: dialect,
  type: 'array',
  maxItems: 100,
  items: recipeSummarySchema,
} as const;

export const dailyRecipesResponseSchema = {
  ...storedRecipesResponseSchema,
  maxItems: 12,
} as const;

export const similarRecipesResponseSchema = {
  ...storedRecipesResponseSchema,
  maxItems: 6,
} as const;

export const searchRecipesResponseSchema = {
  ...dailyRecipesResponseSchema,
  items: {
    ...recipeSummarySchema,
    required: ['sourceId', 'title', 'image'],
    properties: { ...recipeSummarySchema.properties, image: { type: ['string', 'null'] } },
  },
} as const;

const ingredient = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'original', 'amount', 'unit', 'image'],
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
    original: { type: 'string' },
    amount: { type: 'number' },
    unit: { type: 'string' },
    image: { type: 'string' },
  },
} as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const nullableBoolean = { type: ['boolean', 'null'] } as const;

export const recipeDetailResponseSchema = {
  $schema: dialect,
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'title', 'summary', 'instructions', 'ingredients', 'lang'],
  properties: {
    ...recipeSummarySchema.properties,
    summary: { type: 'string' },
    instructions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'steps'],
        properties: {
          name: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['number', 'text'],
              properties: { number: { type: 'number' }, text: { type: 'string' } },
            },
          },
        },
      },
    },
    ingredients: { type: 'array', items: ingredient },
    // Mongo conserva null explícito; undefined se omite al serializar JSON.
    readyInMinutes: nullableNumber,
    servings: nullableNumber,
    vegetarian: nullableBoolean,
    vegan: nullableBoolean,
    glutenFree: nullableBoolean,
    dairyFree: nullableBoolean,
    cookingMinutes: nullableNumber,
    preparationMinutes: nullableNumber,
    healthScore: nullableNumber,
    aggregateLikes: nullableNumber,
    sourceName: { type: ['string', 'null'] },
    sourceUrl: { type: 'string' },
    lang: { type: 'string', enum: ['en', 'es'] },
  },
} as const;

export const ingredientsResponseSchema = {
  $schema: dialect,
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceId', 'title', 'ingredients'],
    properties: {
      sourceId,
      title: { type: 'string' },
      ingredients: { type: 'array', items: ingredient },
    },
  },
} as const;

export type StoredRecipesResponse = FromSchema<typeof storedRecipesResponseSchema>;

export type DailyRecipesResponse = FromSchema<typeof dailyRecipesResponseSchema>;

export type SearchRecipesResponse = FromSchema<typeof searchRecipesResponseSchema>;

export type SimilarRecipesResponse = FromSchema<typeof similarRecipesResponseSchema>;

export type RecipeDetailResponse = FromSchema<typeof recipeDetailResponseSchema>;

export type IngredientsResponse = FromSchema<typeof ingredientsResponseSchema>;
