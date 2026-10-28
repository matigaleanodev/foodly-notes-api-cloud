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
  });

  it('carga secretos una vez en runtime, permite solo campos declarados y no altera process.env', async () => {
    const read = vi.fn(async (arn: string) =>
      JSON.stringify(
        arn.includes('/mongo-')
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
      MONGO_SECRET_ARN: settings.TEST_MONGO_SECRET_ARN,
      PROVIDER_SECRET_ARN: settings.TEST_PROVIDER_SECRET_ARN,
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
    await runtimeEnvironment({ MONGO_SECRET_ARN: settings.TEST_MONGO_SECRET_ARN }, read)();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toEqual([settings.TEST_MONGO_SECRET_ARN, expect.any(AbortSignal)]);
  });

  it('un secreto inválido no se cachea y su error se oculta; la siguiente request puede recuperarse', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce('{"MONGO_URI":7}')
      .mockResolvedValueOnce('{"MONGO_URI":"mongodb://fixture"}');
    const ready = runtimeEnvironment({ MONGO_SECRET_ARN: settings.TEST_MONGO_SECRET_ARN }, read);
    await expect(ready()).rejects.toThrow('Runtime configuration unavailable.');
    expect((await ready()).MONGO_URI).toBe('mongodb://fixture');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
