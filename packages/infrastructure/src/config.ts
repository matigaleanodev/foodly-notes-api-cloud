import { configuration } from '@foodly-notes/contracts/configuration';

export const ACCOUNT = '650387442642';

export const REGION = 'us-east-1';

export const STACK_NAME = 'foodly-notes-api-cloud-test';

/** Solo parámetros no sensibles; los valores de Secrets Manager se leen dentro de Lambda. */
export function deploymentConfiguration(env: NodeJS.ProcessEnv) {
  const required = (name: string, pattern: RegExp) => {
    const value = env[name] ?? '';
    if (!pattern.test(value)) throw new Error(`Invalid or missing ${name}.`);
    return value;
  };
  const role = (name: string) =>
    required(name, /^arn:aws:iam::650387442642:role\/foodly-notes-test-[\w/-]+$/);
  const secret = (name: string, suffix: string) =>
    required(
      name,
      new RegExp(
        `^arn:aws:secretsmanager:us-east-1:650387442642:secret:foodly-notes/test/${suffix}-[A-Za-z0-9]{6}$`,
      ),
    );
  const origins = configuration({
    NODE_ENV: 'production',
    CORS_ORIGIN: env.TEST_CORS_ORIGIN,
  }).origins;
  if (origins.some((origin) => !/^https?:\/\//.test(origin)))
    throw new Error('HTTP API requires HTTP(S) CORS origins.');
  return {
    healthMongoSecretArn: secret('TEST_HEALTH_MONGO_SECRET_ARN', 'mongo-health'),
    mongoSecretArn: secret('TEST_MONGO_SECRET_ARN', 'mongo'),
    providerSecretArn: secret('TEST_PROVIDER_SECRET_ARN', 'providers'),
    healthRoleArn: role('TEST_HEALTH_ROLE_ARN'),
    recipesRoleArn: role('TEST_RECIPES_ROLE_ARN'),
    deploymentBucket: required('TEST_DEPLOYMENT_BUCKET', /^foodly-notes-test-[a-z0-9-]+$/),
    origins,
  };
}

export type DeploymentConfiguration = ReturnType<typeof deploymentConfiguration>;
