import { eventsFor, routes } from './src/routes.ts';

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
    environment: {
      NODE_ENV: 'development',
      CORS_ORIGIN: 'http://localhost:8100,capacitor://localhost',
    },
    httpApi: { payload: '2.0' },
  },
  build: { esbuild: false },
  package: { individually: true },
  functions: {
    health: {
      handler: 'health.handler',
      timeout: 3,
      package: { artifact: 'dist/health.zip' },
      events: [
        ...eventsFor(routes.health),
        { httpApi: { method: 'OPTIONS', path: '/api/{proxy+}' } },
      ],
    },
    recipes: {
      handler: 'recipes.handler',
      package: { artifact: 'dist/recipes.zip' },
      environment: { MONGO_URI: 'mongodb://127.0.0.1:27017/foodly_notes_local' },
      events: eventsFor(routes.recipes),
    },
  },
};
