import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

type ParameterReader = (name: string, signal: AbortSignal) => Promise<string>;

const client = new SSMClient({ maxAttempts: 1 });
const readParameter: ParameterReader = async (name, signal) => {
  const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
    abortSignal: signal,
  });
  if (!result.Parameter?.Value) throw new Error('Parameter unavailable.');
  return result.Parameter?.Value;
};

/** Lee parámetros solo en runtime, comparte inicialización y permite recuperar un fallo transitorio. */
export function runtimeEnvironment(env: NodeJS.ProcessEnv, read: ParameterReader = readParameter) {
  let pending: Promise<NodeJS.ProcessEnv> | undefined;
  return () => {
    pending ??= (async () => {
      const result = { ...env };
      const parameters = [
        {
          name: env.MONGO_PARAMETER_NAME,
          fields: [
            'MONGO_URI',
            ...(env.PUBLIC_ACCESS_ENABLED === 'true' ? ['ORIGIN_VERIFY_SECRET'] : []),
          ],
        },
        {
          name: env.PROVIDER_PARAMETER_NAME,
          fields: ['SPOONACULAR_API_KEY', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION'],
        },
      ];
      const values = await Promise.all(
        parameters.map(async ({ name, fields }) => {
          if (!name) return {};
          const value: unknown = JSON.parse(await read(name, AbortSignal.timeout(2000)));
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid runtime parameter.');
          const record = value as Record<string, unknown>;
          for (const field of fields)
            if (typeof record[field] !== 'string' || !record[field].trim())
              throw new Error('Invalid runtime parameter.');
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
