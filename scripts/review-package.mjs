import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { routes as definitions, methodsFor } from '@foodly-notes/contracts/routes';

const directory = await realpath(resolve(process.argv[2] ?? 'cdk.out'));
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
const stacks = Object.values(manifest.artifacts).filter(
  (artifact) => artifact.type === 'aws:cloudformation:stack',
);
assert.equal(stacks.length, 1);
const stack = stacks[0];
assert.equal(stack.environment, 'aws://650387442642/us-east-1');
assert.equal(stack.properties.stackName, 'foodly-notes-api-cloud-test');
assert.equal(stack.properties.assumeRoleArn, undefined);
const safeFile = async (name) => {
  const path = resolve(directory, name);
  const local = relative(directory, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Asset outside assembly.');
  assert.equal(await realpath(path), path, 'Symlink in asset path.');
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Invalid asset.');
  return path;
};
const contents = await readFile(await safeFile(stack.properties.templateFile), 'utf8');
const template = JSON.parse(contents);
const assets = Object.values(manifest.artifacts).filter(
  (artifact) => artifact.type === 'cdk:asset-manifest',
);
assert.equal(assets.length, 1);
const assetManifest = JSON.parse(await readFile(await safeFile(assets[0].properties.file), 'utf8'));
assert.equal(Object.keys(assetManifest.dockerImages ?? {}).length, 0);
const files = Object.values(assetManifest.files);
assert.equal(files.length, 3);
assert.equal(files.filter((file) => file.source.path.endsWith('.zip')).length, 2);
for (const file of files) {
  await safeFile(file.source.path);
  for (const destination of Object.values(file.destinations)) {
    assert.match(destination.bucketName, /^foodly-notes-test-[a-z0-9-]+$/);
    assert.ok(destination.objectKey.startsWith('foodly-notes-api-cloud-test/'));
    assert.equal(destination.assumeRoleArn, undefined);
  }
}
const resources = Object.values(template.Resources);
const functions = ['health', 'catalog', 'detail', 'ingredients'];
const ofType = (type) => resources.filter((resource) => resource.Type === type);
assert.equal(ofType('AWS::Lambda::Function').length, 4);
assert.equal(ofType('AWS::ApiGatewayV2::Integration').length, 4);
const routes = ofType('AWS::ApiGatewayV2::Route');
assert.equal(routes.length, 13);
assert.deepEqual(
  routes.map((route) => route.Properties.RouteKey).sort(),
  Object.values(definitions)
    .flatMap((route) => methodsFor(route).map((method) => `${method} ${route.path}`))
    .sort(),
);
const entries = Object.entries(template.Resources);
for (const definition of Object.values(definitions)) {
  const fn = entries.find(
    ([, value]) =>
      value.Type === 'AWS::Lambda::Function' &&
      value.Properties.FunctionName === `foodly-notes-api-cloud-test-${definition.group}`,
  );
  assert.ok(fn, 'Missing function.');
  const integrations = entries.filter(
    ([, value]) =>
      value.Type === 'AWS::ApiGatewayV2::Integration' &&
      JSON.stringify(value.Properties.IntegrationUri).includes(JSON.stringify(fn[0])),
  );
  assert.equal(integrations.length, 1);
  const integration = integrations[0];
  assert.equal(integration[1].Properties.PayloadFormatVersion, '2.0');
  for (const method of methodsFor(definition)) {
    const route = routes.find(
      (route) => route.Properties.RouteKey === `${method} ${definition.path}`,
    );
    assert.ok(
      JSON.stringify(route.Properties.Target).includes(JSON.stringify(integration[0])),
      'Wrong Gateway integration.',
    );
  }
}
for (const route of routes) {
  assert.equal(route.Properties.AuthorizationType, 'AWS_IAM');
  assert.doesNotMatch(route.Properties.RouteKey, /ANY|\$default|proxy\+/);
}
for (const fn of ofType('AWS::Lambda::Function')) {
  const name = functions.find(
    (name) => fn.Properties.FunctionName === `foodly-notes-api-cloud-test-${name}`,
  );
  assert.ok(name);
  assert.equal(fn.Properties.Handler, name === 'health' ? 'health.handler' : `recipes.${name}`);
  assert.equal(fn.Properties.Runtime, 'nodejs24.x');
  assert.ok(fn.Properties.Environment.Variables.MONGO_SECRET_ARN);
  if (name === 'health')
    assert.equal(fn.Properties.Environment.Variables.PROVIDER_SECRET_ARN, undefined);
  else assert.equal(fn.Properties.Environment.Variables.REAL_PROVIDERS_ENABLED, 'false');
  assert.ok(fn.Properties.Timeout <= 29);
  assert.match(fn.Properties.Role, /^arn:aws:iam::650387442642:role\/foodly-notes-test-/);
}
for (const fn of ofType('AWS::Lambda::Function'))
  assert.equal(fn.Properties.ReservedConcurrentExecutions, undefined);
assert.equal(ofType('AWS::ApiGatewayV2::Stage').length, 1);
assert.deepEqual(ofType('AWS::ApiGatewayV2::Stage')[0].Properties.DefaultRouteSettings, {
  ThrottlingBurstLimit: 6,
  ThrottlingRateLimit: 4,
});
for (const api of ofType('AWS::ApiGatewayV2::Api')) {
  assert.equal(api.Properties.ProtocolType, 'HTTP');
  assert.ok(api.Properties.CorsConfiguration.AllowOrigins.length);
  assert.ok(!api.Properties.CorsConfiguration.AllowOrigins.includes('*'));
}
const allowed = new Set([
  'AWS::Lambda::Function',
  'AWS::Lambda::Permission',
  'AWS::Logs::LogGroup',
  'AWS::ApiGatewayV2::Api',
  'AWS::ApiGatewayV2::Stage',
  'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Route',
]);
for (const resource of resources)
  assert.ok(allowed.has(resource.Type), `Unexpected resource: ${resource.Type}`);
assert.doesNotMatch(contents, /resolve:secretsmanager|mongodb(?:\+srv)?:\/\/|AKIA[0-9A-Z]{16}/);
console.info(
  'Assembly CDK revisada: cuatro Lambdas/integraciones, trece rutas explícitas, dos ZIP, sin nuevos IAM/red/secretos.',
);
