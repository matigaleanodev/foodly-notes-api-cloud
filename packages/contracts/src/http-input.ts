import { ingredientsRequestSchema } from './ingredients.ts';

// Strings decimales aceptados por Number, con ceros iniciales y límite seguro.
function decimalString(maximum: number) {
  const digits = String(maximum);
  const alternatives = ['[1-9][0-9]{0,' + (digits.length - 2) + '}'];
  for (let index = 0; index < digits.length; index++) {
    const low = index === 0 ? 1 : 0;
    const high = Number(digits[index]) - 1;
    if (high >= low)
      alternatives.push(
        digits.slice(0, index) + `[${low}-${high}]` + '[0-9]{' + (digits.length - index - 1) + '}',
      );
  }
  alternatives.push(digits);
  return { type: 'string', pattern: '^0*(?:' + alternatives.join('|') + ')$' } as const;
}

const lang = {
  type: 'string',
  pattern: '^\\s*(?:[eE][nN]|[eE][sS])\\s*$',
  description: 'Trim y lowercase; si se omite, en. No acepta null ni repetidos.',
} as const;

export const storedRecipesHttpQuerySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      ...decimalString(100),
      description: 'Decimal 1–100; admite ceros iniciales. Omitido: 50.',
    },
    after: {
      ...decimalString(9007199254740991),
      description: 'Cursor exclusivo, entero positivo seguro.',
    },
  },
} as const;

export const recipeLangHttpQuerySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: { lang },
} as const;

export const searchRecipesHttpQuerySchema = {
  ...recipeLangHttpQuerySchema,
  required: ['q'],
  properties: {
    lang,
    q: {
      type: 'string',
      pattern: '^\\s*(?:[^\\p{Cc}\\s](?:[^\\p{Cc}]{0,198}[^\\p{Cc}\\s])?)\\s*$',
      description:
        'Tras trim: 1–200 caracteres Unicode sin controles (Cc). Espacios/controles recortables en extremos se aceptan; el patrón conserva esta condición sobre el texto recortado.',
    },
  },
} as const;

export const recipeHttpPathSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
  required: ['id'],
  properties: { id: decimalString(9007199254740991) },
} as const;

export const ingredientsHttpRequestSchema = {
  ...ingredientsRequestSchema,
  description:
    'JSON hasta 16384 bytes decodificados. IDs decimales string o number; tras conversión deben ser únicos (1 y "001" se rechazan juntos). lang se normaliza y por omisión es en. No admite extras. uniqueItems comprueba además duplicados literales.',
  properties: {
    sourceIds: {
      ...ingredientsRequestSchema.properties.sourceIds,
      items: {
        anyOf: [
          ingredientsRequestSchema.properties.sourceIds.items,
          decimalString(9007199254740991),
        ],
      },
    },
    lang,
  },
} as const;
