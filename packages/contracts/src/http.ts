import type { FromSchema, JSONSchema } from 'json-schema-to-ts';

function errorSchema<
  const Status extends number,
  const Message extends JSONSchema,
  const Label extends string | undefined,
>(status: Status, message: Message, label?: Label) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: label ? ['statusCode', 'message', 'error'] : ['statusCode', 'message'],
    properties: {
      statusCode: { const: status },
      message,
      ...(label ? { error: { const: label } } : {}),
    },
  } as const;
}

export const httpErrorSchemas = {
  400: errorSchema(
    400,
    {
      anyOf: [
        { const: 'Invalid JSON request body.' },
        { type: 'array', minItems: 1, items: { type: 'string' } },
      ],
    },
    'Bad Request',
  ),
  403: errorSchema(403, { const: 'Forbidden' }, 'Forbidden'),
  404: errorSchema(
    404,
    { anyOf: [{ const: 'Recipe not found.' }, { type: 'string', pattern: '^Cannot ' }] },
    'Not Found',
  ),
  413: errorSchema(413, { const: 'Request body too large.' }, 'Payload Too Large'),
  414: errorSchema(414, { const: 'Request URL too long.' }),
  415: errorSchema(415, { const: 'Content-Type must be application/json.' }),
  429: errorSchema(429, { const: 'ThrottlerException: Too Many Requests' }),
  500: errorSchema(500, { const: 'Internal server error' }),
  502: errorSchema(502, { const: 'Recipe provider unavailable.' }, 'Bad Gateway'),
  503: errorSchema(
    503,
    {
      enum: [
        'Request limit verification unavailable.',
        'Service busy. Retry later.',
        'Provider daily budget exhausted. Retry later.',
        'Provider budget verification unavailable.',
        'External providers disabled.',
      ],
    },
    'Service Unavailable',
  ),
} as const;

export type HttpErrorResponse = FromSchema<
  (typeof httpErrorSchemas)[keyof typeof httpErrorSchemas]
>;

const fixedHeader = (value: string) => ({
  schema: { type: 'string', const: value },
  'x-required': true,
});

export const commonResponseHeaders = {
  'cache-control': fixedHeader('no-store'),
  'x-content-type-options': fixedHeader('nosniff'),
  'x-frame-options': fixedHeader('SAMEORIGIN'),
  'referrer-policy': fixedHeader('no-referrer'),
  'cross-origin-opener-policy': fixedHeader('same-origin'),
  'cross-origin-resource-policy': fixedHeader('same-origin'),
  'origin-agent-cluster': fixedHeader('?1'),
  'x-dns-prefetch-control': fixedHeader('off'),
  'x-download-options': fixedHeader('noopen'),
  'x-permitted-cross-domain-policies': fixedHeader('none'),
  'x-xss-protection': fixedHeader('0'),
  vary: fixedHeader('Origin'),
  'content-security-policy': {
    schema: { type: 'string' },
    description: 'Política del middleware; agrega upgrade-insecure-requests en producción.',
    'x-required': true,
  },
  'strict-transport-security': {
    schema: { type: 'string', const: 'max-age=31536000' },
    description: 'Solo en producción.',
  },
  'x-request-id': { schema: { type: 'string' }, 'x-required': true },
} as const;

export const retryHeaders = {
  'retry-after': {
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
    description: 'Segundos hasta reintentar: ventana de cuota, día UTC o 5 ante indisponibilidad.',
    'x-required': true,
  },
} as const;

export const quotaResponseHeaders = Object.fromEntries(
  ['', '-global'].flatMap((suffix) =>
    ['limit', 'remaining', 'reset'].map((name) => [
      `x-ratelimit-${name}${suffix}`,
      {
        schema: { type: 'string', pattern: '^[0-9]+$' },
        'x-required': true,
        description:
          name === 'reset'
            ? 'Segundos hasta el cierre de la ventana.'
            : 'Cuota por ruta/IP o global/IP.',
      },
    ]),
  ),
);

export function response<const Schema extends JSONSchema>(
  schema: Schema,
  description: string,
  headers: Record<string, unknown> = {},
) {
  return {
    schema,
    description,
    headers: { ...commonResponseHeaders, ...headers },
    mediaType: 'application/json; charset=utf-8',
  } as const;
}

export const commonErrorResponses = {
  403: response(httpErrorSchemas[403], 'Metadata de invocación inválida.'),
  404: response(httpErrorSchemas[404], 'Integración/ruta incorrecta o receta ausente.'),
  414: response(httpErrorSchemas[414], 'URL mayor de 4096 caracteres.'),
  500: response(httpErrorSchemas[500], 'Fallo inesperado saneado.'),
} as const;

export const recipeErrorResponses = {
  ...commonErrorResponses,
  400: response(httpErrorSchemas[400], 'Entrada inválida; conserva mensajes y orden del runtime.'),
  429: response(httpErrorSchemas[429], 'Cuota de ruta o global agotada.', retryHeaders),
  503: response(
    httpErrorSchemas[503],
    'Cuota/presupuesto no verificable, presupuesto agotado o deadline/capacidad.',
    retryHeaders,
  ),
} as const;

export const providerErrorResponses = {
  ...recipeErrorResponses,
  502: response(
    httpErrorSchemas[502],
    'Respuesta o transporte Spoonacular inválido/no disponible.',
  ),
} as const;
