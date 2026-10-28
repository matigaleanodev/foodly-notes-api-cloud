import {
  CliCredentialsStackSynthesizer,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { CfnApi, CfnIntegration, CfnRoute, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { CfnFunction, CfnPermission } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { resolve } from 'node:path';
import { routes, methodsFor, recipeGroups } from '@foodly-notes/contracts/routes';
import { ACCOUNT, REGION, STACK_NAME, type DeploymentConfiguration } from './config.ts';

interface FoodlyNotesStackProps extends StackProps {
  configuration: DeploymentConfiguration;
  assetDirectory?: string;
}

/** Declara recursos AWS directamente; sin lookups, creación de IAM o resolución de secretos. */
export class FoodlyNotesStack extends Stack {
  constructor(scope: Construct, id: string, props: FoodlyNotesStackProps) {
    const config = props.configuration;
    super(scope, id, {
      ...props,
      env: { account: ACCOUNT, region: REGION },
      stackName: STACK_NAME,
      synthesizer: new CliCredentialsStackSynthesizer({
        fileAssetsBucketName: config.deploymentBucket,
        bucketPrefix: 'foodly-notes-api-cloud-test/',
      }),
    });
    const assets = Object.fromEntries(
      ['health', 'recipes'].map((name) => [
        name,
        new Asset(this, `${name}Asset`, {
          path: resolve(props.assetDirectory ?? 'dist', `${name}.zip`),
        }),
      ]),
    );
    const accessLogs = new CfnLogGroup(this, 'AccessLogs', {
      logGroupName: `/aws/apigateway/${STACK_NAME}`,
      retentionInDays: 14,
    });
    const api = new CfnApi(this, 'Api', {
      name: STACK_NAME,
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: config.origins,
        allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Accept'],
        exposeHeaders: [
          'Retry-After',
          'X-RateLimit-Limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Reset',
        ],
        allowCredentials: false,
        maxAge: Duration.minutes(10).toSeconds(),
      },
    });
    new CfnStage(this, 'Stage', {
      apiId: api.ref,
      stageName: '$default',
      autoDeploy: true,
      defaultRouteSettings: { throttlingBurstLimit: 6, throttlingRateLimit: 4 },
      accessLogSettings: {
        destinationArn: accessLogs.attrArn,
        format:
          '{"requestId":"$context.requestId","route":"$context.routeKey","status":"$context.status","integrationStatus":"$context.integrationStatus","durationMs":"$context.responseLatency"}',
      },
    });
    const integrations: Record<string, CfnIntegration> = {};
    for (const name of ['health', ...recipeGroups]) {
      const health = name === 'health';
      const file = assets[health ? 'health' : 'recipes']!;
      const logs = new CfnLogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/${STACK_NAME}-${name}`,
        retentionInDays: 14,
      });
      const fn = new CfnFunction(this, `${name}Function`, {
        functionName: `${STACK_NAME}-${name}`,
        handler: health ? 'health.handler' : `recipes.${name}`,
        runtime: 'nodejs24.x',
        architectures: ['arm64'],
        memorySize: 256,
        timeout: health ? 4 : 29,
        role: health ? config.healthRoleArn : config.recipesRoleArn,
        code: { s3Bucket: file.s3BucketName, s3Key: file.s3ObjectKey },
        loggingConfig: { logGroup: logs.ref },
        environment: {
          variables: {
            NODE_ENV: 'production',
            CORS_ORIGIN: config.origins.join(','),
            MONGO_SECRET_ARN: health ? config.healthMongoSecretArn : config.mongoSecretArn,
            ...(health
              ? {}
              : {
                  PROVIDER_SECRET_ARN: config.providerSecretArn,
                  SPOONACULAR_BASE_URL: 'https://api.spoonacular.com',
                  SPOONACULAR_DAILY_REQUEST_LIMIT: '100',
                  AZURE_DAILY_CHARACTER_LIMIT: '50000',
                  PROVIDER_MAX_CONCURRENCY: '4',
                  REAL_PROVIDERS_ENABLED: 'false',
                }),
          },
        },
      });
      integrations[name] = new CfnIntegration(this, `${name}Integration`, {
        apiId: api.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: fn.attrArn,
        payloadFormatVersion: '2.0',
        timeoutInMillis: 30000,
      });
      new CfnPermission(this, `${name}GatewayPermission`, {
        action: 'lambda:InvokeFunction',
        functionName: fn.attrArn,
        principal: 'apigateway.amazonaws.com',
        sourceAccount: ACCOUNT,
        sourceArn: `arn:aws:execute-api:${REGION}:${ACCOUNT}:${api.ref}/*/*`,
      });
    }
    for (const [name, route] of Object.entries(routes)) {
      for (const method of methodsFor(route)) {
        new CfnRoute(this, `${name}${method}Route`, {
          apiId: api.ref,
          routeKey: `${method} ${route.path}`,
          target: `integrations/${integrations[route.group]!.ref}`,
          authorizationType: 'AWS_IAM',
        });
      }
    }
    new CfnOutput(this, 'ApiUrl', { value: api.attrApiEndpoint });
  }
}
