import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stackFixture } from './infra-fixtures.ts';

describe('Revisor de assembly CDK', () => {
  it('revisa CF sintetizado y rechaza acceso anónimo, rutas duplicadas, destino incorrecto y roles nuevos', async () => {
    const { directory, app } = await stackFixture();
    try {
      const assembly = app.synth();
      const file = join(
        assembly.directory,
        assembly.getStackArtifact('FoodlyNotesTest').templateFile,
      );
      const value = await readFile(file, 'utf8');
      const cases = [
        { value, expected: 0 },
        { value: value.replace('"AWS_IAM"', '"NONE"'), expected: 1 },
        { value: value.replace('GET /api/recipes/daily', 'GET /api/recipes/search'), expected: 1 },
        { value: value.replace('"catalogIntegration"', '"detailIntegration"'), expected: 1 },
        { value: value.replace('"AWS::ApiGatewayV2::Api"', '"AWS::IAM::Role"'), expected: 1 },
      ];
      for (const scenario of cases) {
        await writeFile(file, scenario.value);
        const result = spawnSync(
          process.execPath,
          ['scripts/review-package.mjs', assembly.directory],
          { encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(scenario.expected);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
