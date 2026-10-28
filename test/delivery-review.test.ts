import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stackFixture } from './infra-fixtures.ts';

const revision = 'a'.repeat(40);
const python = (...args: string[]) => spawnSync('python3', args, { encoding: 'utf8' });

describe('Artifact revisado entre preparación y ejecución', () => {
  it('conserva metadata referenciada, excluye archivos obsoletos y detecta cambios o faltantes', async () => {
    const { directory, app } = await stackFixture();
    const output = await mkdtemp(join(tmpdir(), 'foodly-delivery-'));
    try {
      const assembly = app.synth();
      await cp(assembly.directory, join(directory, 'cdk.out'), { recursive: true });
      await cp('package-lock.json', join(directory, 'package-lock.json'));
      await cp('.nvmrc', join(directory, '.nvmrc'));
      await writeFile(join(directory, 'cdk.out', 'obsolete.json'), '{}');
      const bundle = join(output, 'reviewed');
      const created = python(
        'scripts/review_bundle.py',
        'create',
        directory,
        bundle,
        revision,
        process.version,
      );
      expect(created.status, created.stderr).toBe(0);
      const verify = () => python('scripts/review_bundle.py', 'verify', bundle, revision);
      expect(verify().status).toBe(0);
      const checksums = JSON.parse(await readFile(join(bundle, 'checksums.json'), 'utf8'));
      expect(checksums['cdk.out/obsolete.json']).toBeUndefined();
      const manifest = JSON.parse(await readFile(join(bundle, 'cdk.out/manifest.json'), 'utf8'));
      const stack = manifest.artifacts.FoodlyNotesTest;
      if (stack.additionalMetadataFile) {
        expect(checksums[`cdk.out/${stack.additionalMetadataFile}`]).toBeTypeOf('string');
      }
      await writeFile(join(bundle, 'unexpected.txt'), 'extra');
      expect(verify().status).toBe(1);
      await rm(join(bundle, 'unexpected.txt'));
      expect(verify().status).toBe(0);
      const lock = join(bundle, 'package-lock.json');
      await writeFile(lock, '{}');
      expect(verify().status).toBe(1);
      await cp('package-lock.json', lock);
      expect(python('scripts/review_bundle.py', 'verify', bundle, 'b'.repeat(40)).status).toBe(1);
      await rm(join(bundle, 'cdk.out', stack.properties.templateFile));
      expect(verify().status).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  it('rechaza cambios destructivos y admite actualización después de rollback completado', () => {
    const source = `
import sys
sys.path.insert(0, 'scripts')
from review_changeset import validate, PREFIX, STACK, ROLE
stack = PREFIX + 'stack/' + STACK + '/id'
name = STACK + '-' + 'a' * 40 + '-1-1'
changeset = PREFIX + 'changeSet/' + name + '/id'
change = {'StackId': stack, 'ChangeSetId': changeset, 'StackName': STACK, 'ChangeSetName': name, 'Status': 'CREATE_COMPLETE', 'ExecutionStatus': 'AVAILABLE', 'Changes': [{'ResourceChange': {'ResourceType': 'AWS::Lambda::Function', 'Action': 'Modify', 'Replacement': 'False'}}]}
state = {'StackId': stack, 'RoleARN': ROLE, 'StackStatus': 'UPDATE_ROLLBACK_COMPLETE'}
template = {'Resources': {'Function': {'Type': 'AWS::Lambda::Function'}}}
validate(change, state, template, stack, changeset)
def rejected():
    try:
        validate(change, state, template, stack, changeset)
    except ValueError:
        return
    raise AssertionError('Cambio inválido aceptado')
state['StackStatus'] = 'ROLLBACK_COMPLETE'
rejected()
state['StackStatus'] = 'CREATE_COMPLETE'
change['Changes'][0]['ResourceChange']['Replacement'] = 'True'
rejected()
change['Changes'][0]['ResourceChange']['Replacement'] = 'False'
change['Changes'][0]['ResourceChange']['Action'] = 'Remove'
rejected()
`;
    const result = python('-c', source);
    expect(result.status, result.stderr).toBe(0);
  });
});
