import { Ajv } from 'ajv';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { IngredientsRequest } from '@foodly-notes/contracts/ingredients';
import type { HealthResponse } from '@foodly-notes/contracts/health';
import type {
  StoredRecipesQuery,
  RecipeLangQuery,
  SearchRecipesQuery,
  RecipePath,
} from '@foodly-notes/contracts/recipes';
import { routes } from '@foodly-notes/contracts/routes';

const ajv = new Ajv({ allErrors: true });
const validateIngredients = ajv.compile<IngredientsRequest>(routes.ingredients.request.body);
const validateHealth = ajv.compile<HealthResponse>(routes.health.responses[200].schema);

describe('Contratos neutrales HTTP', () => {
  it('expone metadata serializable para CDK y OpenAPI sin cargar runtime ni validadores', async () => {
    expect(JSON.parse(JSON.stringify(routes))).toEqual(routes);
    expect(routes.health.responses[503].schema).toBe(routes.health.responses[200].schema);
    const bundled = await build({
      entryPoints: ['packages/contracts/src/routes.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
    });
    expect(Object.keys(bundled.metafile!.inputs).sort()).toEqual([
      'packages/contracts/src/health.ts',
      'packages/contracts/src/http-input.ts',
      'packages/contracts/src/http.ts',
      'packages/contracts/src/ingredients.ts',
      'packages/contracts/src/recipes.ts',
      'packages/contracts/src/responses.ts',
      'packages/contracts/src/routes.ts',
    ]);
  });

  it('CDK conserva metadata neutral y configuración pura sin clientes runtime', async () => {
    const bundled = await build({
      entryPoints: ['packages/infrastructure/src/stack.ts'],
      bundle: true,
      external: ['aws-cdk-lib', 'aws-cdk-lib/*', 'constructs'],
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(bundled.metafile!.inputs).every(
        (path) =>
          path.startsWith('packages/infrastructure/src/') ||
          path.startsWith('packages/contracts/src/') ||
          path === 'packages/contracts/src/routes.ts' ||
          path === 'packages/contracts/src/configuration.ts',
      ),
    ).toBe(true);
    expect(
      Object.values(bundled.metafile!.outputs)
        .flatMap((output) => output.imports)
        .some((entry) => entry.path.includes('axios')),
    ).toBe(false);
  });

  it('valida la forma canónica sin coerción, defaults ni eliminación de campos', () => {
    const input: IngredientsRequest = { sourceIds: [1, Number.MAX_SAFE_INTEGER], lang: 'es' };
    expect(validateIngredients(input)).toBe(true);
    expect(validateIngredients({ sourceIds: [1] })).toBe(true);
    const raw = { sourceIds: ['001'], lang: ' ES ', extra: true };
    expect(validateIngredients(raw)).toBe(false);
    expect(raw).toEqual({ sourceIds: ['001'], lang: ' ES ', extra: true });
  });

  it('comparte contratos de idioma/path y distingue búsqueda y listado sin agregar validaciones', () => {
    expect(routes.detail.request.query).toBe(routes.daily.request.query);
    expect(routes.similar.request.query).toBe(routes.daily.request.query);
    expect(routes.similar.request.path).toBe(routes.detail.request.path);
    expect(routes.health).not.toHaveProperty('request');
    expect(routes.ingredients.request).not.toHaveProperty('query');
    const stored = ajv.compile<StoredRecipesQuery>(routes.recipes.request.query);
    const lang = ajv.compile<RecipeLangQuery>(routes.daily.request.query);
    const search = ajv.compile<SearchRecipesQuery>(routes.search.request.query);
    const path = ajv.compile<RecipePath>(routes.detail.request.path);
    const canonical: StoredRecipesQuery = { limit: 100, after: Number.MAX_SAFE_INTEGER };
    expect(stored(canonical)).toBe(true);
    expect(stored({})).toBe(false);
    expect(lang({})).toBe(true);
    expect(lang({ lang: null })).toBe(false);
    expect(lang({ q: 'rice' })).toBe(false);
    const query: SearchRecipesQuery = { q: 'rice', lang: 'en' };
    expect(search(query)).toBe(true);
    expect(search({ lang: 'en' })).toBe(false);
    const params: RecipePath = { id: Number.MAX_SAFE_INTEGER, ignored: 'value' };
    expect(path(params)).toBe(true);
    expect(path({})).toBe(false);
    expect(path({ id: 0 })).toBe(false);
    const raw = { limit: '001', extra: 'value' };
    expect(stored(raw)).toBe(false);
    expect(raw).toEqual({ limit: '001', extra: 'value' });
    expect(search({ q: ' rice ', lang: ' ES ' })).toBe(false);
    expect(path({ id: '001' })).toBe(false);
  });

  it.each(['ok', 'error'] as const)(
    'acepta cada resultado de configuración %s con cualquiera de Mongo',
    (status) => {
      for (const mongoStatus of ['ok', 'error'] as const) {
        const response: HealthResponse = [
          { name: 'configuration', status },
          { name: 'mongo', status: mongoStatus },
        ];
        expect(validateHealth(response)).toBe(true);
      }
    },
  );

  it.each([
    { value: { results: [{ name: 'mongo', status: 'ok' }] } },
    { value: [] },
    { value: [{ name: 'configuration', status: 'ok' }] },
    {
      value: [
        { name: 'configuration', status: 'ok' },
        { name: 'configuration', status: 'error' },
      ],
    },
    {
      value: [
        { name: 'configuration', status: 'ok' },
        { name: 'mongo', status: 'pending' },
      ],
    },
    {
      value: [
        { name: 'configuration', status: 'ok' },
        { name: 'mongo', status: 'ok', detail: 'private' },
      ],
    },
  ])('rechaza respuestas health incompletas o fuera de contrato: $value', ({ value }) => {
    expect(validateHealth(value)).toBe(false);
  });
});
