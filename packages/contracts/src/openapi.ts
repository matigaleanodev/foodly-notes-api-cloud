import type { JSONSchema } from 'json-schema-to-ts';
import { routes, methodsFor } from './routes.ts';

interface Parameter {
  name: string;
  in: 'query' | 'path';
  required: boolean;
  schema: JSONSchema;
  style: 'form' | 'simple';
  explode: false;
}
interface Operation {
  operationId: string;
  description: string;
  parameters: Parameter[];
  responses: Record<
    string,
    {
      description: string;
      headers: Record<string, unknown>;
      content?: Record<string, { schema: JSONSchema }>;
    }
  >;
  requestBody?: { required: boolean; content: Record<string, { schema: JSONSchema }> };
  'x-canonical-request'?: unknown;
  'x-http-input'?: unknown;
  'x-lambda-group': string;
}

/** Documento de revisión local: nunca se importa en Gateway ni publica una ruta de docs. */
export function createOpenApiDocument(publicAccess = false) {
  const paths: Record<string, Record<string, Operation>> = {};
  for (const route of Object.values(routes)) {
    paths[route.path] = {};
    for (const method of methodsFor(route)) {
      const parameters: Parameter[] = [];
      if ('httpInput' in route) {
        for (const location of ['path', 'query'] as const) {
          if (!(location in route.httpInput)) continue;
          const input = route.httpInput[location as keyof typeof route.httpInput] as {
            properties: Record<string, JSONSchema>;
            required?: readonly string[];
          };
          for (const [name, schema] of Object.entries(input.properties)) {
            parameters.push({
              name,
              in: location,
              required: location === 'path' || !!input.required?.includes(name),
              schema,
              style: location === 'path' ? 'simple' : 'form',
              explode: false,
            });
          }
        }
      }
      const operation: Operation = {
        operationId: route.operation + (method === 'HEAD' ? 'Head' : ''),
        'x-lambda-group': route.group,
        description:
          (route.group === 'health'
            ? 'Sin cuotas/proveedores; query ignorada.'
            : 'Cuotas antes de query/path; body de ingredientes antes de cuotas. Query antes de id. HEAD ejecuta el mismo trabajo, consume cuotas/budgets y omite el body. Repetidos y extras query rechazados salvo queries de health/ingredientes, que se ignoran. Path extra ignorado.') +
          ' URL máxima 4096 caracteres. Los errores descritos son de Lambda; Gateway puede rechazar antes con su propio payload (IAM, throttling, matching). CORS/preflight pertenece a Gateway.',
        parameters,
        responses: Object.fromEntries(
          Object.entries(route.responses).map(([status, contract]) => [
            status,
            {
              description: contract.description,
              headers: contract.headers,
              ...(method === 'HEAD'
                ? {}
                : { content: { [contract.mediaType]: { schema: contract.schema } } }),
            },
          ]),
        ),
      };
      if ('request' in route) operation['x-canonical-request'] = route.request;
      if ('httpInput' in route) {
        operation['x-http-input'] = route.httpInput;
        if ('body' in route.httpInput)
          operation.requestBody = {
            required: true,
            content: { 'application/json': { schema: route.httpInput.body } },
          };
      }
      paths[route.path]![method.toLowerCase()] = operation;
    }
  }
  return {
    openapi: '3.1.1',
    jsonSchemaDialect: 'http://json-schema.org/draft-07/schema#',
    info: {
      title: 'Foodly Notes HTTP contracts',
      version: '1.0.0',
      description:
        (publicAccess
          ? 'Acceso público a través de Cloudflare con origen verificado y cuotas por visitante. '
          : 'Acceso AWS_IAM (SigV4). ') +
        'Requiere tooling con dialecto draft-07; no convierte schemas a OpenAPI 3.0. x-http-input describe entrada previa a normalización; x-canonical-request describe valores validados después de parsing/normalización (limit=50 en listado; lang=en efectivo por omisión). La unicidad de sourceIds después de Number es una condición adicional del runtime que uniqueItems no expresa entre tipos distintos. Errores Gateway/CORS/preflight requieren comprobación en AWS y no comparten necesariamente schemas ni headers de Lambda.',
    },
    security: publicAccess ? [] : [{ sigv4: [] }],
    components: {
      securitySchemes: {
        sigv4: {
          type: 'http',
          scheme: 'AWS4-HMAC-SHA256',
          description:
            'Firma AWS SigV4 exigida por AWS_IAM en las trece rutas del entorno test; sin API keys.',
        },
      },
    },
    paths,
  };
}
