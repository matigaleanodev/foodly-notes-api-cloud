import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { FoundationStack } from '../packages/infrastructure/src/foundation.ts';
import {
  applicationPolicies,
  CEILING,
  foundationPolicy,
  githubTrust,
} from '../packages/infrastructure/src/delivery-policies.ts';

describe('Fundación personal de la candidata', () => {
  it('limita cinco identidades con un ceiling externo y conserva bucket y secretos', () => {
    const stack = new FoundationStack(new App({ analyticsReporting: false }), 'FoundationTest');
    const template = Template.fromStack(stack).toJSON();
    const resources = Object.values(template.Resources) as {
      Type: string;
      Properties: Record<string, unknown>;
      DeletionPolicy?: string;
    }[];
    const roles = resources.filter((r) => r.Type === 'AWS::IAM::Role');
    expect(roles).toHaveLength(5);
    expect(roles.every((r) => r.Properties.PermissionsBoundary === CEILING)).toBe(true);
    expect(resources.filter((r) => r.Type === 'AWS::IAM::ManagedPolicy')).toHaveLength(0);
    expect(resources.filter((r) => r.Type === 'AWS::SecretsManager::Secret')).toHaveLength(3);
    expect(
      resources
        .filter((r) => r.Type === 'AWS::SecretsManager::Secret' || r.Type === 'AWS::S3::Bucket')
        .every((r) => r.DeletionPolicy === 'Retain'),
    ).toBe(true);
    expect(template.Parameters.AllowRegionalApiBootstrap.Default).toBe('false');
    expect(JSON.stringify(template)).not.toMatch(
      /AWS::EC2::|AWS::DynamoDB::|portfolio|resolve:secretsmanager/,
    );
  });

  it('separa preparar, ejecutar y runtime; el ejecutor de fundación no puede cambiar ceilings o roles de acceso', () => {
    const scopes = applicationPolicies('example', false);
    expect(JSON.stringify(scopes.prepare)).not.toContain('ExecuteChangeSet');
    expect(JSON.stringify(scopes.execute)).not.toContain('CreateChangeSet');
    expect(JSON.stringify(scopes.health)).not.toMatch(/providers|s3:|iam:|cloudformation:/);
    expect(JSON.stringify(scopes.recipes)).not.toMatch(/iam:|cloudformation:/);
    expect(JSON.stringify(foundationPolicy())).not.toMatch(
      /CreatePolicy|CreatePolicyVersion|foundation-cloudformation|sts:AssumeRole/,
    );
    expect(JSON.stringify(scopes.cloudformation)).not.toContain('Request/ApiName');
    expect(JSON.stringify(scopes.cloudformation)).toContain('/apis/example');
    expect(JSON.stringify(githubTrust('test'))).toContain(
      'repo:matigaleanodev/foodly-notes-api-cloud:environment:test',
    );
  });
});
