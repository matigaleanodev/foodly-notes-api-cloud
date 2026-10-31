import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { deploymentConfiguration } from '../packages/infrastructure/src/config.ts';
import { settings } from './infra-fixtures.ts';
import { runtimeEnvironment } from '../packages/runtime/src/runtime/secrets.ts';

describe('Preparación local de entrega', () => {
  it('falla cerrado sin parámetros y rechaza roles ajenos a cuenta/entorno', () => {
    expect(() => deploymentConfiguration({})).toThrow();
    expect(() =>
      deploymentConfiguration({
        ...settings,
        TEST_RECIPES_ROLE_ARN: 'arn:aws:iam::111111111111:role/admin',
      }),
    ).toThrow();
    expect(() => deploymentConfiguration({ ...settings, TEST_CORS_ORIGIN: '*' })).toThrow();
    expect(() =>
      deploymentConfiguration({ ...settings, TEST_CORS_ORIGIN: 'capacitor://localhost' }),
    ).toThrow('HTTP API requires HTTP(S) CORS origins.');
    expect(deploymentConfiguration(settings).origins).toContain('https://localhost');
    expect(() => deploymentConfiguration({ ...settings, PUBLIC_ACCESS_ENABLED: 'yes' })).toThrow();
    expect(() =>
      deploymentConfiguration({ ...settings, REAL_PROVIDERS_ENABLED: 'true' }),
    ).toThrow();
  });

  it('rechaza referencias SSM de otra cuenta, aplicación o dominio', () => {
    for (const value of [
      '/portfolio/prod/api',
      '/foodly-notes/test/mongo',
      'arn:aws:ssm:us-east-1:111111111111:parameter/foodly-notes/test/mongo-health',
    ])
      expect(() =>
        deploymentConfiguration({ ...settings, TEST_HEALTH_MONGO_PARAMETER_NAME: value }),
      ).toThrow();
    expect(() =>
      deploymentConfiguration({ ...settings, TEST_RUNTIME_CONFIGURATION_REVISION: '' }),
    ).toThrow();
  });

  it('usa GetParameter descifrado con deadline y conserva el error saneado', async () => {
    const send = vi.spyOn(SSMClient.prototype, 'send').mockImplementation(async () => ({
      Parameter: { Value: '{"MONGO_URI":"mongodb://fixture"}' },
    }));
    try {
      const ready = runtimeEnvironment({
        MONGO_PARAMETER_NAME: settings.TEST_MONGO_PARAMETER_NAME,
      });
      expect((await ready()).MONGO_URI).toBe('mongodb://fixture');
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
      expect((send.mock.calls[0]![0] as GetParameterCommand).input).toEqual({
        Name: settings.TEST_MONGO_PARAMETER_NAME,
        WithDecryption: true,
      });
      expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: expect.any(AbortSignal) });
      send.mockImplementation(async () => {
        throw new Error('sensitive connection string');
      });
      await expect(
        runtimeEnvironment({ MONGO_PARAMETER_NAME: settings.TEST_MONGO_PARAMETER_NAME })(),
      ).rejects.toThrow('Runtime configuration unavailable.');
    } finally {
      send.mockRestore();
    }
  });

  it('carga secretos una vez en runtime, permite solo campos declarados y no altera process.env', async () => {
    const read = vi.fn(async (arn: string) =>
      JSON.stringify(
        arn.includes('/mongo')
          ? { MONGO_URI: 'mongodb://fixture', ignored: 'private' }
          : {
              SPOONACULAR_API_KEY: 'fixture',
              AZURE_TRANSLATOR_KEY: 'fixture',
              AZURE_TRANSLATOR_REGION: 'fixture',
              ignored: 'private',
            },
      ),
    );
    const env = {
      MONGO_PARAMETER_NAME: settings.TEST_MONGO_PARAMETER_NAME,
      PROVIDER_PARAMETER_NAME: settings.TEST_PROVIDER_PARAMETER_NAME,
    };
    const ready = runtimeEnvironment(env, read);
    const [a, b] = await Promise.all([ready(), ready()]);
    expect(a).toBe(b);
    expect(a.MONGO_URI).toBe('mongodb://fixture');
    expect(a).not.toHaveProperty('ignored');
    expect(env).not.toHaveProperty('MONGO_URI');
    expect(await ready()).toBe(a);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('health con solo el ARN Mongo nunca pide secretos de proveedores', async () => {
    const read = vi.fn(async () => JSON.stringify({ MONGO_URI: 'mongodb://fixture' }));
    await runtimeEnvironment({ MONGO_PARAMETER_NAME: settings.TEST_MONGO_PARAMETER_NAME }, read)();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toEqual([
      settings.TEST_MONGO_PARAMETER_NAME,
      expect.any(AbortSignal),
    ]);
  });

  it('un secreto inválido no se cachea y su error se oculta; la siguiente request puede recuperarse', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce('{"MONGO_URI":7}')
      .mockResolvedValueOnce('{"MONGO_URI":"mongodb://fixture"}');
    const ready = runtimeEnvironment(
      { MONGO_PARAMETER_NAME: settings.TEST_MONGO_PARAMETER_NAME },
      read,
    );
    await expect(ready()).rejects.toThrow('Runtime configuration unavailable.');
    expect((await ready()).MONGO_URI).toBe('mongodb://fixture');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
