import {
  BootstraplessSynthesizer,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CfnDomainName, CfnApiMapping } from 'aws-cdk-lib/aws-apigatewayv2';
import type { Construct } from 'constructs';
import { ACCOUNT, REGION } from './config.ts';
import {
  applicationPolicies,
  BUCKET,
  CEILING,
  githubTrust,
  policy,
  PREFIX,
  serviceTrust,
} from './delivery-policies.ts';

/** Fundación sin assets ni bootstrap; IAM limitado por un ceiling externo que esta stack no puede editar. */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      env: { account: ACCOUNT, region: REGION },
      stackName: 'foodly-notes-api-cloud-test-foundation',
      synthesizer: new BootstraplessSynthesizer(),
    });
    const host = new CfnParameter(this, 'MongoHost', {
      type: 'String',
      allowedPattern: '[a-z0-9.-]+\\.mongodb\\.net',
    });
    const apiId = new CfnParameter(this, 'TestApiId', {
      type: 'String',
      default: 'unassigned',
      allowedPattern: 'unassigned|[a-z0-9]{1,20}',
    });
    const bootstrap = new CfnParameter(this, 'AllowRegionalApiBootstrap', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
    });
    const domainEnabled = new CfnParameter(this, 'ProductionDomainEnabled', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
    });
    const domainCondition = new CfnCondition(this, 'ProductionDomain', {
      expression: Fn.conditionEquals(domainEnabled.valueAsString, 'true'),
    });
    const certificateArn = new CfnParameter(this, 'CertificateArn', {
      type: 'String',
      default: '',
      allowedPattern: '^$|arn:aws:acm:us-east-1:650387442642:certificate/[a-f0-9-]+',
    });
    const createCertificate = new CfnCondition(this, 'CreateCertificate', {
      expression: Fn.conditionAnd(
        domainCondition,
        Fn.conditionEquals(certificateArn.valueAsString, ''),
      ),
    });
    const certificate = new CfnCertificate(this, 'ApiCertificate', {
      domainName: 'api.foodlynotes.app',
      validationMethod: 'DNS',
      tags: [{ key: 'Project', value: 'foodly-notes-api-cloud' }],
    });
    certificate.cfnOptions.condition = createCertificate;
    certificate.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const domain = new CfnDomainName(this, 'ApiDomain', {
      domainName: 'api.foodlynotes.app',
      tags: { Project: 'foodly-notes-api-cloud' },
      domainNameConfigurations: [
        {
          certificateArn: Fn.conditionIf(
            createCertificate.logicalId,
            certificate.ref,
            certificateArn.valueAsString,
          ).toString(),
          endpointType: 'REGIONAL',
          securityPolicy: 'TLS_1_2',
        },
      ],
    });
    domain.cfnOptions.condition = domainCondition;
    const mapping = new CfnApiMapping(this, 'ApiMapping', {
      apiId: apiId.valueAsString,
      domainName: domain.ref,
      stage: '$default',
    });
    mapping.cfnOptions.condition = domainCondition;
    new CfnOutput(this, 'ApiRegionalDomain', {
      value: domain.attrRegionalDomainName,
      condition: domainCondition,
    });
    const initial = new CfnCondition(this, 'RegionalApiBootstrap', {
      expression: Fn.conditionEquals(bootstrap.valueAsString, 'true'),
    });
    const bucket = new CfnBucket(this, 'Assets', {
      bucketName: BUCKET,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      },
      ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          { serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } },
        ],
      },
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [
          {
            id: 'BoundPreviousVersions',
            status: 'Enabled',
            noncurrentVersionExpiration: { noncurrentDays: 30 },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
          },
        ],
      },
    });
    bucket.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnBucketPolicy(this, 'AssetsPolicy', {
      bucket: bucket.ref,
      policyDocument: policy([
        {
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ]),
    });
    const mongoUri = Fn.sub(
      'mongodb+srv://${MongoHost}/foodly_notes_rc?authSource=%24external&authMechanism=MONGODB-AWS&tls=true&appName=foodly-notes-rc',
      { MongoHost: host.valueAsString },
    );
    for (const name of ['mongo-health', 'mongo', 'providers']) {
      const secret = new CfnSecret(this, name.replace('-', ''), {
        name: `foodly-notes/test/${name}`,
        secretString:
          name === 'providers'
            ? JSON.stringify({
                SPOONACULAR_API_KEY: 'disabled',
                AZURE_TRANSLATOR_KEY: 'disabled',
                AZURE_TRANSLATOR_REGION: 'disabled',
              })
            : Fn.toJsonString({ MONGO_URI: mongoUri }),
      });
      secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
      new CfnOutput(this, `${name.replace('-', '')}Arn`, { value: secret.ref });
    }
    const statements = applicationPolicies(apiId.valueAsString);
    for (const [name, permissions] of Object.entries(statements)) {
      const role = new CfnRole(this, `${name}Role`, {
        roleName: `${PREFIX}${name}`,
        permissionsBoundary: CEILING,
        assumeRolePolicyDocument:
          name === 'prepare' || name === 'execute'
            ? githubTrust('test')
            : serviceTrust(
                name === 'cloudformation' ? 'cloudformation.amazonaws.com' : 'lambda.amazonaws.com',
              ),
        policies: [
          {
            policyName: 'project',
            policyDocument:
              name === 'cloudformation'
                ? Fn.conditionIf(
                    initial.logicalId,
                    policy(applicationPolicies().cloudformation),
                    policy(applicationPolicies(apiId.valueAsString, false).cloudformation),
                  )
                : policy(permissions),
          },
        ],
      });
      new CfnOutput(this, `${name}RoleArn`, { value: role.attrArn });
    }
    new CfnOutput(this, 'DeploymentBucket', { value: bucket.ref });
  }
}
