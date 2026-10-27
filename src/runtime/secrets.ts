import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

type SecretReader = (arn: string, signal: AbortSignal) => Promise<string>;

const client = new SecretsManagerClient({ maxAttempts: 1 });
const readSecret: SecretReader = async (arn, signal) => {
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
    abortSignal: signal,
  });
  if (!result.SecretString) throw new Error('Secret unavailable.');
  return result.SecretString;
};

/** Lee secretos solo en runtime, comparte inicialización y permite recuperar un fallo transitorio. */
export function runtimeEnvironment(env: NodeJS.ProcessEnv, read: SecretReader = readSecret) {
  let pending: Promise<NodeJS.ProcessEnv> | undefined;
  return () => {
    pending ??= (async () => {
      const result = { ...env };
      const secrets = [
        { arn: env.MONGO_SECRET_ARN, fields: ['MONGO_URI'] },
        {
          arn: env.PROVIDER_SECRET_ARN,
          fields: ['SPOONACULAR_API_KEY', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION'],
        },
      ];
      const values = await Promise.all(
        secrets.map(async ({ arn, fields }) => {
          if (!arn) return {};
          const value: unknown = JSON.parse(await read(arn, AbortSignal.timeout(2000)));
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid runtime secret.');
          const record = value as Record<string, unknown>;
          for (const field of fields)
            if (typeof record[field] !== 'string' || !record[field].trim())
              throw new Error('Invalid runtime secret.');
          return Object.fromEntries(fields.map((field) => [field, record[field] as string]));
        }),
      );
      return Object.assign(result, ...values);
    })().catch(() => {
      pending = undefined;
      throw new Error('Runtime configuration unavailable.');
    });
    return pending;
  };
}
