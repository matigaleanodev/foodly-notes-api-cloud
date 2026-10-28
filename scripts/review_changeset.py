#!/usr/bin/env python3
"""Revisa el changeset y sus ZIP publicados; no ejecuta mutaciones AWS."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

PREFIX = 'arn:aws:cloudformation:us-east-1:650387442642:'
STACK = 'foodly-notes-api-cloud-test'
ROLE = 'arn:aws:iam::650387442642:role/foodly-notes-test-cloudformation'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def targets(stack, changeset):
    if not re.fullmatch(re.escape(PREFIX + 'stack/' + STACK + '/') + r'[A-Za-z0-9-]+', stack):
        raise ValueError('Stack fuera del destino previsto')
    if not re.fullmatch(re.escape(PREFIX + 'changeSet/' + STACK + '-') + r'[a-f0-9]{40}-[0-9]+-[0-9]+/[A-Za-z0-9-]+', changeset):
        raise ValueError('Changeset fuera del destino previsto')


def validate(change, stack_data, template, stack, changeset):
    targets(stack, changeset)
    if (change.get('StackId'), change.get('ChangeSetId'), change.get('StackName'), change.get('ChangeSetName')) != (stack, changeset, STACK, changeset.split('/')[-2]):
        raise ValueError('Identidad del changeset alterada')
    if change.get('Status') != 'CREATE_COMPLETE' or change.get('ExecutionStatus') != 'AVAILABLE' or change.get('NextToken'):
        raise ValueError('Changeset incompleto o no disponible')
    if change.get('ImportExistingResources') or change.get('NotificationARNs') or change.get('ParentChangeSetId') or change.get('RootChangeSetId') not in (None, changeset):
        raise ValueError('Alcance adicional no permitido')
    if stack_data.get('StackId') != stack or stack_data.get('RoleARN') != ROLE:
        raise ValueError('Ejecutor CloudFormation inesperado')
    if stack_data.get('StackStatus') not in ('REVIEW_IN_PROGRESS', 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
        raise ValueError('Recuperación requiere revisar el estado real antes de continuar')
    changes = change.get('Changes', [])
    if not changes:
        raise ValueError('Changeset vacío')
    allowed = {'AWS::Lambda::Function', 'AWS::Lambda::Permission', 'AWS::Logs::LogGroup', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Stage', 'AWS::ApiGatewayV2::Integration', 'AWS::ApiGatewayV2::Route'}
    if any(value['Type'] not in allowed for value in template['Resources'].values()):
        raise ValueError('Recursos fuera de la aplicación')
    for item in changes:
        resource = item.get('ResourceChange', {})
        if resource.get('ResourceType') not in allowed or resource.get('ChangeSetId'):
            raise ValueError('Cambio fuera de alcance')
        if resource.get('Action') == 'Remove' or resource.get('Replacement') in ('True', 'Conditional'):
            raise ValueError('Eliminación o reemplazo requiere revisión específica')
    return {key: change[key] for key in ('StackId', 'StackName', 'ChangeSetId', 'ChangeSetName', 'Changes', 'Parameters', 'Capabilities') if key in change}


def aws(*args):
    result = subprocess.run(['aws', *args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def snapshot(assembly, stack, changeset):
    targets(stack, changeset)
    manifest = json.loads((assembly / 'manifest.json').read_text())
    source = manifest['artifacts']['FoodlyNotesTest']['properties']['templateFile']
    expected = json.loads((assembly / source).read_text())
    change = aws('cloudformation', 'describe-change-set', '--stack-name', stack, '--change-set-name', changeset)
    stacks = aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks']
    if len(stacks) != 1:
        raise ValueError('Stack ambigua')
    template = aws('cloudformation', 'get-template', '--stack-name', stack, '--change-set-name', changeset, '--template-stage', 'Original')['TemplateBody']
    if isinstance(template, str):
        template = json.loads(template)
    if template != expected:
        raise ValueError('Template distinto del assembly revisado')
    reviewed = validate(change, stacks[0], template, stack, changeset)
    assets = json.loads((assembly / manifest['artifacts']['FoodlyNotesTest.assets']['properties']['file']).read_text())
    objects = []
    codes = {json.dumps(resource['Properties']['Code'], sort_keys=True) for resource in template['Resources'].values() if resource['Type'] == 'AWS::Lambda::Function'}
    for value in sorted(codes):
        code = json.loads(value)
        matches = [asset for asset in assets['files'].values() if any(d['bucketName'] == code['S3Bucket'] and d['objectKey'] == code['S3Key'] for d in asset['destinations'].values())]
        if len(matches) != 1 or not matches[0]['source']['path'].endswith('.zip'):
            raise ValueError('ZIP sin fuente única')
        local = (assembly / matches[0]['source']['path']).read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'asset.zip'
            metadata = aws('s3api', 'get-object', '--bucket', code['S3Bucket'], '--key', code['S3Key'], str(output))
            if output.read_bytes() != local:
                raise ValueError('Los bytes publicados no coinciden con el assembly revisado')
        objects.append({'bucket': code['S3Bucket'], 'key': code['S3Key'], 'version': metadata.get('VersionId'), 'sha256': hashlib.sha256(local).hexdigest()})
    return {'change': reviewed, 'role': stacks[0]['RoleARN'], 'templateHash': digest(template), 'objects': objects}


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('La lectura administrada se realiza desde Actions')
    assembly, stack, changeset, output = sys.argv[1:]
    value = snapshot(Path(assembly), stack, changeset)
    Path(output).write_text(json.dumps(value, indent=2) + '\n')
    print('sha256:' + digest(value))