import { App } from 'aws-cdk-lib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import settings from '../packages/infrastructure/src/local-settings.json' with { type: 'json' };
import { deploymentConfiguration } from '../packages/infrastructure/src/config.ts';
import { FoodlyNotesStack } from '../packages/infrastructure/src/stack.ts';

export { settings };

/** Assets ZIP vacíos distintos para probar infraestructura, sin simular ejecución Lambda. */
export async function stackFixture(overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'foodly-cdk-test-'));
  for (const name of ['health', 'recipes']) {
    const header = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    header.writeUInt16LE(name.length, 20);
    await writeFile(join(directory, `${name}.zip`), Buffer.concat([header, Buffer.from(name)]));
  }
  const app = new App({
    outdir: join(directory, 'assembly'),
    analyticsReporting: false,
    context: { 'aws:cdk:version-reporting': false },
  });
  const stack = new FoodlyNotesStack(app, 'FoodlyNotesTest', {
    configuration: deploymentConfiguration({ ...settings, ...overrides }),
    assetDirectory: directory,
  });
  return { directory, app, stack };
}
