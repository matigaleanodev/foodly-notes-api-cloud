import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractName = '@foodly-notes/contracts';
const allowed = {
  contracts: new Set(),
  infrastructure: new Set([contractName, 'aws-cdk-lib', 'constructs']),
  runtime: new Set([
    contractName,
    '@aws-sdk/client-secrets-manager',
    '@aws-sdk/credential-providers',
    '@middy/core',
    'ajv',
    'axios',
    'ipaddr.js',
    'mongoose',
    'sanitize-html',
  ]),
};

function dependencyName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function checkImport(owner, manifest, file, specifier, typeOnly) {
  if (specifier.startsWith('node:')) {
    assert.notEqual(owner, 'contracts', 'Los contratos no dependen de Node.');
    return;
  }
  if (specifier.startsWith('.')) {
    const target = relative(
      resolve(root, 'packages', owner, 'src'),
      resolve(dirname(file), specifier),
    );
    assert.ok(!target.startsWith('..'), `Import relativo fuera del paquete: ${file}: ${specifier}`);
    return;
  }
  const name = dependencyName(specifier);
  const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  const typePackage = manifest.devDependencies?.[`@types/${name}`];
  assert.ok(declared || (typeOnly && typePackage), `Dependencia no declarada: ${file}: ${name}`);
  const typeDependency =
    owner === 'contracts' ? 'json-schema-to-ts' : owner === 'runtime' ? 'aws-lambda' : undefined;
  assert.ok(
    (typeOnly && name === typeDependency) ||
      (allowed[owner].has(name) && manifest.dependencies?.[name]),
    `Dependencia de ejecución fuera del límite: ${file}: ${name}`,
  );
  if (name.startsWith('@foodly-notes/')) {
    assert.equal(name, contractName, `Dependencia entre paquetes no permitida: ${file}`);
    assert.ok(specifier.startsWith(`${contractName}/`), 'Usar exports explícitos.');
  }
}

// Autocontroles negativos: el hoisting no habilita imports ni escapes entre paquetes.
const fixture = resolve(root, 'packages/infrastructure/src/config.ts');
assert.throws(() => checkImport('infrastructure', {}, fixture, 'axios', false));
assert.throws(() =>
  checkImport('infrastructure', { dependencies: { axios: '1.21.0' } }, fixture, 'axios', false),
);
assert.throws(() =>
  checkImport('infrastructure', {}, fixture, '../../runtime/src/health/handler.ts', false),
);
assert.throws(() => checkImport('contracts', {}, fixture, 'node:fs', false));
assert.throws(() =>
  checkImport('infrastructure', { devDependencies: { axios: '1.21.0' } }, fixture, 'axios', true),
);
assert.throws(() => checkImport('runtime', {}, fixture, 'aws-lambda', true));
assert.throws(() =>
  checkImport(
    'runtime',
    { dependencies: { '@foodly-notes/infrastructure': '0.1.0' } },
    fixture,
    '@foodly-notes/infrastructure',
    true,
  ),
);

async function files(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.name !== 'node_modules',
  );
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}

const contractManifest = JSON.parse(
  await readFile(resolve(root, 'packages/contracts/package.json'), 'utf8'),
);
for (const owner of Object.keys(allowed)) {
  const directory = resolve(root, 'packages', owner);
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, contractManifest.version);
  assert.ok(!('scripts' in manifest) || !('prepare' in manifest.scripts));
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert.ok(allowed[owner].has(name), `Dependencia fuera del límite: ${owner}: ${name}`);
    if (name.startsWith('@foodly-notes/')) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/, 'Conservar versiones exactas.');
      assert.equal(version, contractManifest.version);
    } else assert.match(version, /^\d+\.\d+\.\d+$/, 'Conservar versiones exactas.');
  }
  assert.equal(
    (await files(directory)).some((path) => path.endsWith('package-lock.json')),
    false,
  );
  for (const file of await files(resolve(directory, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(file, 'utf8');
    // Import/export estáticos, incluidos los que esbuild borra por ser solo tipos.
    const imports = source.matchAll(
      /\b(?:import|export)\s+(?:(type)\s+)?(?:[^;'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    );
    for (const [, type, specifier] of imports) {
      checkImport(owner, manifest, file, specifier, !!type);
      if (specifier.startsWith(`${contractName}/`)) {
        assert.ok(
          contractManifest.exports[`./${specifier.slice(contractName.length + 1)}`],
          `Export no declarado: ${specifier}`,
        );
      }
    }
    for (const [, specifier] of source.matchAll(/\b(?:import|require)\(['"]([^'"]+)['"]\)/g)) {
      checkImport(owner, manifest, file, specifier, false);
    }
  }
}
console.info('Límites de imports/dependencias y exports de los tres paquetes comprobados.');
