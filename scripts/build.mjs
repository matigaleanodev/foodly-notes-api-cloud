import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
for (const name of ['health', 'recipes']) {
  const result = await build({
    entryPoints: [`src/${name}.ts`],
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
  if (name === 'health' && inputs.some((file) => /mongoose|mongodb|database/.test(file))) {
    throw new Error('Health must be independent of MongoDB.');
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
const { createRecipesHandler } = await import('../dist/recipes.mjs');
const { default: assert } = await import('node:assert/strict');
assert.equal((await createHealthHandler()(event('/api/health'), context)).statusCode, 200);
const localStore = {
  increment: async () => 1,
  list: async () => [{ sourceId: 7, base: { title: 'Local recipe' } }],
};
const response = await createRecipesHandler(localStore)(event(), context);
assert.equal(response.statusCode, 200);
assert.deepEqual(JSON.parse(response.body), [{ sourceId: 7, title: 'Local recipe' }]);
console.info('Smoke de ambos bundles aprobado sin conexiones externas.');
