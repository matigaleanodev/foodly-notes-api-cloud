import { createOpenApiDocument } from '../src/contracts/openapi.ts';
import { rm } from 'node:fs/promises';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { stackFixture } from './infra-fixtures.ts';
import { routes, methodsFor } from '../src/http/routes.ts';

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
      expect(
        Object.values(functions).reduce(
          (sum, fn) => sum + fn.Properties.ReservedConcurrentExecutions,
          0,
        ),
      ).toBe(6);
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
          AllowOrigins: [
            'https://test.foodlynotes.app',
            'capacitor://localhost',
            'http://localhost',
          ],
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
            CORS_ORIGIN: 'https://test.foodlynotes.app,capacitor://localhost,http://localhost',
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
});
