import { createOpenApiDocument } from '@foodly-notes/contracts/openapi';
import { rm } from 'node:fs/promises';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { stackFixture } from './infra-fixtures.ts';
import { routes, methodsFor } from '@foodly-notes/contracts/routes';

describe('Stack CDK y API Gateway por responsabilidad', () => {
  it('sintetiza cuatro Lambdas y mapea las trece rutas explícitas a su grupo', async () => {
    const { directory, stack } = await stackFixture();
    try {
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::Lambda::Function', 4);
      template.resourceCountIs('AWS::ApiGatewayV2::Integration', 4);
      template.resourceCountIs('AWS::ApiGatewayV2::Route', 13);
      template.resourceCountIs('AWS::ApiGatewayV2::Model', 0);
      template.resourceCountIs('AWS::ApiGateway::RequestValidator', 0);
      template.resourceCountIs('AWS::IAM::Role', 0);
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
      template.resourceCountIs('AWS::EC2::VPC', 0);
      const functions = template.findResources('AWS::Lambda::Function');
      for (const fn of Object.values(functions))
        expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
      for (const [name, group] of Object.entries({
        health: 'health',
        catalog: 'recipes',
        detail: 'recipes',
        ingredients: 'recipes',
      }))
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: `foodly-notes-api-cloud-test-${name}`,
          Handler: name === 'health' ? 'health.handler' : `${group}.${name}`,
          Runtime: 'nodejs24.x',
          Architectures: ['arm64'],
        });
      const document = createOpenApiDocument();
      const documentedKeys = Object.entries(document.paths).flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      );
      const routeResources = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
      expect(routeResources.map((value) => value.Properties.RouteKey).sort()).toEqual(
        Object.values(routes)
          .flatMap((route) => methodsFor(route).map((method) => `${method} ${route.path}`))
          .sort(),
      );
      expect(
        routeResources.every((value) => value.Properties.AuthorizationType === 'AWS_IAM'),
      ).toBe(true);
      for (const route of routeResources) {
        expect(route.Properties.RequestModels).toBeUndefined();
        expect(route.Properties.RequestParameters).toBeUndefined();
      }
      expect(documentedKeys.sort()).toEqual(
        routeResources.map((value) => value.Properties.RouteKey).sort(),
      );
      const apiResources = Object.values(template.findResources('AWS::ApiGatewayV2::Api'));
      expect(apiResources[0]!.Properties.Body).toBeUndefined();
      expect(apiResources[0]!.Properties.BodyS3Location).toBeUndefined();
      const byKey = Object.fromEntries(
        routeResources.map((value) => [value.Properties.RouteKey, value.Properties.Target]),
      );
      expect(byKey['GET /api/recipes']).toEqual(byKey['GET /api/recipes/daily']);
      expect(byKey['GET /api/recipes/search']).toEqual(byKey['GET /api/recipes/daily']);
      expect(byKey['GET /api/recipes/{id}']).toEqual(byKey['GET /api/recipes/{id}/similar']);
      expect(byKey['POST /api/recipes/ingredients']).not.toEqual(byKey['GET /api/recipes/{id}']);
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: {
          AllowOrigins: ['https://test.foodlynotes.app', 'https://localhost', 'http://localhost'],
          AllowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
          MaxAge: 600,
          AllowCredentials: false,
        },
      });
      expect(routeResources.some((value) => value.Properties.RouteKey.startsWith('OPTIONS '))).toBe(
        false,
      );
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'foodly-notes-api-cloud-test-health',
        Environment: {
          Variables: {
            NODE_ENV: 'production',
            CORS_ORIGIN: 'https://test.foodlynotes.app,https://localhost,http://localhost',
            MONGO_SECRET_ARN:
              'arn:aws:secretsmanager:us-east-1:650387442642:secret:foodly-notes/test/mongo-health-Ab1234',
          },
        },
      });
      expect(JSON.stringify(template.toJSON())).not.toMatch(
        /resolve:secretsmanager|mongodb(?:\+srv)?:\/\/|AKIA/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('habilita acceso público protegido sobre las mismas funciones y rutas', async () => {
    const { directory, stack } = await stackFixture({
      PUBLIC_ACCESS_ENABLED: 'true',
      REAL_PROVIDERS_ENABLED: 'true',
    });
    try {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: true });
      for (const route of Object.values(template.findResources('AWS::ApiGatewayV2::Route')))
        expect(route.Properties.AuthorizationType).toBe('NONE');
      for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
        expect(fn.Properties.Environment.Variables.PUBLIC_ACCESS_ENABLED).toBe('true');
        if (fn.Properties.FunctionName.endsWith('-health'))
          expect(fn.Properties.Environment.Variables.PROVIDER_SECRET_ARN).toBeUndefined();
        else expect(fn.Properties.Environment.Variables.REAL_PROVIDERS_ENABLED).toBe('true');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
