import { Ajv, type ValidateFunction } from 'ajv';
import { expect } from 'vitest';
import type { JSONSchema } from 'json-schema-to-ts';
import type { Route } from '@foodly-notes/contracts/routes';
import type { HttpResult } from '../packages/runtime/src/http/middleware.ts';

const ajv = new Ajv({ allErrors: true });
const validators = new Map<JSONSchema, ValidateFunction>();

function validator(schema: JSONSchema) {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema)!;
}

/** Comprueba el JSON serializado y los headers, exclusivamente desde pruebas. */
export function expectResponseContract(route: Route, result: HttpResult, method = 'GET') {
  const contracts: Record<
    number,
    { schema: JSONSchema; mediaType: string; headers: Record<string, unknown> }
  > = route.responses;
  const contract = contracts[result.statusCode!];
  expect(contract, `${method} ${route.path}: estado ${result.statusCode} declarado`).toBeDefined();
  expect(result.headers?.['content-type']).toBe(contract!.mediaType);
  for (const [name, value] of Object.entries(contract!.headers)) {
    const header = value as { schema: JSONSchema; 'x-required'?: boolean };
    const actual = result.headers?.[name];
    if (header['x-required']) expect(actual, name).toBeDefined();
    if (actual !== undefined) {
      const validate = validator(header.schema);
      expect(validate(actual), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  }
  if (method === 'HEAD') expect(result.body).toBe('');
  else {
    const validate = validator(contract!.schema);
    expect(validate(JSON.parse(result.body!)), JSON.stringify(validate.errors)).toBe(true);
  }
}
