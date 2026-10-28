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
  it('admite solo el permiso idéntico cuyo ARN depende de una actualización de código sin recreación', () => {
    const source = `
import copy, sys
sys.path.insert(0, 'scripts')
from review_changeset import stable_permission, STACK
name = STACK + '-health'
function = {'Type': 'AWS::Lambda::Function', 'Properties': {'FunctionName': name, 'Role': 'same-role', 'Code': {'S3Key': 'new.zip'}}}
permission = {'Type': 'AWS::Lambda::Permission', 'Properties': {'FunctionName': {'Fn::GetAtt': ['healthFunction', 'Arn']}, 'Action': 'lambda:InvokeFunction', 'Principal': 'apigateway.amazonaws.com', 'SourceArn': 'same-api'}}
template = {'Resources': {'healthFunction': function, 'healthPermission': permission}}
prior = copy.deepcopy(template)
prior['Resources']['healthFunction']['Properties']['Code']['S3Key'] = 'old.zip'
function_change = {'ResourceChange': {'LogicalResourceId': 'healthFunction', 'Action': 'Modify', 'Replacement': 'False', 'PhysicalResourceId': name, 'Details': [{'Target': {'Attribute': 'Properties', 'Name': 'Code', 'RequiresRecreation': 'Never'}, 'Evaluation': 'Static', 'ChangeSource': 'DirectModification'}]}}
resource = {'LogicalResourceId': 'healthPermission', 'ResourceType': 'AWS::Lambda::Permission', 'Action': 'Modify', 'Replacement': 'Conditional', 'Scope': ['Properties'], 'Details': [{'Target': {'Attribute': 'Properties', 'Name': 'FunctionName', 'RequiresRecreation': 'Always'}, 'Evaluation': 'Dynamic', 'ChangeSource': 'ResourceAttribute', 'CausingEntity': 'healthFunction.Arn'}]}
assert stable_permission(resource, [function_change], template, prior)
assert not stable_permission(resource, [function_change], template, None)
for target, field, value in [(resource, 'Replacement', 'True'), (resource, 'Action', 'Remove'), (resource['Details'][0], 'CausingEntity', 'other.Arn'), (function_change['ResourceChange'], 'Replacement', 'Conditional'), (function['Properties'], 'FunctionName', STACK + '-other'), (function['Properties'], 'Role', 'another-role'), (permission['Properties'], 'SourceArn', 'another-api')]:
    old = target[field]
    target[field] = value
    assert not stable_permission(resource, [function_change], template, prior), (field, value)
    target[field] = old
`;
    const result = python('-c', source);
    expect(result.status, result.stderr).toBe(0);
  });
});
