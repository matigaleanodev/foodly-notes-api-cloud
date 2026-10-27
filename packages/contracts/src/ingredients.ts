import type { FromSchema } from 'json-schema-to-ts';

/** Contrato estructural después de normalizar IDs decimales e idioma en Lambda. */
export const ingredientsRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['sourceIds'],
  properties: {
    sourceIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
    },
    lang: { type: 'string', enum: ['en', 'es'] },
  },
} as const;

export type IngredientsRequest = FromSchema<typeof ingredientsRequestSchema>;
