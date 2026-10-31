import type { FromSchema } from 'json-schema-to-ts';

/** Resultados independientes en el orden público: configuración, Mongo. */
export const healthResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'status'],
      properties: {
        name: { const: 'configuration' },
        status: { type: 'string', enum: ['ok', 'error'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'status'],
      properties: {
        name: { const: 'mongo' },
        status: { type: 'string', enum: ['ok', 'error'] },
      },
    },
  ],
  additionalItems: false,
} as const;

export type HealthResponse = FromSchema<typeof healthResponseSchema>;
