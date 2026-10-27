import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
for (const name of ['health', 'recipes']) {
  const result = await build({
    entryPoints: [`src/${name}/handler.ts`],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    metafile: true,
    legalComments: 'none',
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some((file) => !file.startsWith('src/') && !file.startsWith('node_modules/'))) {
    throw new Error('Unexpected input in runtime package.');
  }
  const file = `dist/${name}.mjs`;
  const contents = await readFile(file, 'utf8');
  if (/mongodb(?:\+srv)?:\/\/[^'"\s]+@|AKIA[0-9A-Z]{16}/.test(contents)) {
    throw new Error('Sensitive configuration in package.');
  }
  execFileSync('python3', [
    '-c',
    'import sys,zipfile,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); z.write(p,p.name); z.close()',
    file,
    `dist/${name}.zip`,
  ]);
  await writeFile(`dist/${name}.inputs.json`, JSON.stringify(inputs, null, 2) + '\n');
  console.info(`${name}.zip: un único bundle, sin archivos locales privados.`);
}

const { event, context } = await import('../test/helpers.ts');
const { createHealthHandler } = await import('../dist/health.mjs');
const bundled = await import('../dist/recipes.mjs');
const { routes, recipeRoutes } = await import('../src/http/routes.ts');
const { default: assert } = await import('node:assert/strict');
assert.equal(
  (
    await createHealthHandler(undefined, { ping: async () => undefined })(
      event('/api/health'),
      context,
    )
  ).statusCode,
  200,
);
const localStore = {
  increment: async () => 1,
  recipesByIds: async () => [await localStore.recipe(7)],
  list: async () => [{ sourceId: 7, base: { title: 'Local recipe' } }],
  recipe: async (sourceId) => ({
    sourceId,
    source: 'spoonacular',
    originalLang: 'en',
    base: {
      title: 'Local recipe',
      summary: '<b>Safe</b><script>bad()</script>',
      instructions: [],
      ingredients: [],
    },
    meta: {},
    translations: {},
  }),
  daily: async () => ({ recipes: [{ sourceId: 7, title: 'Local recipe' }] }),
};
const localProviders = {
  search: async () => [{ id: 7, title: 'Local recipe', image: null }],
  similar: async () => [{ sourceId: 7, title: 'Local recipe' }],
  detail: async () => {
    throw new Error('Unexpected cache miss');
  },
  daily: async () => {
    throw new Error('Unexpected cache miss');
  },
  translate: async () => {
    throw new Error('Unexpected translation');
  },
};
const samples = {
  getAllRecipes: event(),
  getDailyRecipes: event('/api/recipes/daily'),
  searchRecipes: event('/api/recipes/search', 'q=rice'),
  getRecipeDetails: event('/api/recipes/7'),
  getSimilarRecipes: event('/api/recipes/7/similar'),
  getIngredients: event('/api/recipes/ingredients', '', '127.0.0.1', 'POST'),
};
samples.getIngredients.headers['content-type'] = 'application/json';
samples.getIngredients.body = JSON.stringify({ sourceIds: [7] });
for (const route of recipeRoutes) {
  assert.equal(typeof bundled[route.group], 'function');
  const fixed = bundled.createRecipeGroupHandler(
    route.group,
    localStore,
    undefined,
    localProviders,
  );
  const response = await fixed(samples[route.operation], context);
  assert.equal(response.statusCode, route.method === 'POST' ? 201 : 200);
  if (route === routes.detail) assert.equal(JSON.parse(response.body).summary, '<b>Safe</b>');
}
assert.equal(bundled.handler, undefined);
for (const removed of ['list', 'daily', 'search', 'similar'])
  assert.equal(bundled[removed], undefined);
console.info(
  'Smoke de siete operaciones en cuatro exports por responsabilidad aprobado sin conexiones externas.',
);
