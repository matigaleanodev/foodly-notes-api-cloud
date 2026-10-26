import { configuration } from './src/runtime/config.ts';
import { eventsFor, routes, recipeRoutes, type RecipeRoute } from './src/http/routes.ts';

const localEnvironment = {
  NODE_ENV: 'development',
  CORS_ORIGIN: 'http://localhost:8100,capacitor://localhost',
};
const recipeFunction = (route: RecipeRoute) => ({
  handler: `recipes.${route.handler}`,
  timeout: 29,
  package: { artifact: 'dist/recipes.zip' },
  environment: { MONGO_URI: 'mongodb://127.0.0.1:27017/foodly_notes_local' },
  events: eventsFor(route),
});
const recipeFunctions = Object.fromEntries(
  recipeRoutes.map((route) => [route.handler, recipeFunction(route)]),
) as Record<RecipeRoute['handler'], ReturnType<typeof recipeFunction>>;

// Configuración local sintética; entrega OIDC/secretos y acceso de prueba se cierran en etapa 4.
export default {
  service: 'foodly-notes-api-cloud',
  frameworkVersion: '4.45.0',
  configValidationMode: 'error',
  provider: {
    name: 'aws',
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    region: 'us-east-1',
    stage: 'local',
    memorySize: 256,
    timeout: 10,
    logRetentionInDays: 14,
    environment: localEnvironment,
    httpApi: {
      payload: '2.0',
      cors: {
        allowedOrigins: configuration(localEnvironment).origins,
        allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Accept'],
        exposedResponseHeaders: [
          'Retry-After',
          'X-RateLimit-Limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Reset',
        ],
        maxAge: 600,
        allowCredentials: false,
      },
    },
  },
  build: { esbuild: false },
  package: { individually: true },
  functions: {
    health: {
      handler: 'health.handler',
      timeout: 3,
      package: { artifact: 'dist/health.zip' },
      events: eventsFor(routes.health),
    },
    ...recipeFunctions,
  },
};
