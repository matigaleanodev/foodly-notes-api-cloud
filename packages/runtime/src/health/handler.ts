import { runtimeEnvironment } from '../runtime/secrets.ts';
import { configuration } from '@foodly-notes/contracts/configuration';
import { database, type Database } from '../runtime/database.ts';
import { http, json } from '../http/middleware.ts';
import { routes } from '@foodly-notes/contracts/routes';
import type { HealthResponse } from '@foodly-notes/contracts/health';

/** Ejecuta checks independientes, acotados y sin escrituras; no expone errores internos. */
export function createHealthHandler(
  env: NodeJS.ProcessEnv = process.env,
  db?: Pick<Database, 'ping'>,
) {
  const ready = runtimeEnvironment(env);
  const healthDb = db ?? database(async () => (await ready()).MONGO_URI, 1);
  // Los middleware solo necesitan production; la configuración se valida dentro de su propio check.
  const middlewareConfig = {
    production: env.NODE_ENV === 'production',
    origins: [],
    routeLimit: 0,
    globalLimit: 0,
  };
  return http(
    routes.health,
    middlewareConfig,
    async (_event, context) => {
      const duration = Math.max(1, Math.min(3000, context.getRemainingTimeInMillis() - 500));
      const checks = [
        {
          name: 'configuration',
          work: async (_signal: AbortSignal) => {
            configuration(env);
          },
        },
        { name: 'mongo', work: (signal: AbortSignal) => healthDb.ping(signal) },
      ] as const;
      const results = await Promise.allSettled(
        checks.map(async ({ work }) => {
          const controller = new AbortController();
          let abort: () => void = () => undefined;
          const timeout = new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('Health check timeout.'));
            controller.signal.addEventListener('abort', abort, { once: true });
          });
          const timer = setTimeout(() => controller.abort(), duration);
          try {
            await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
          } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
            controller.abort();
          }
        }),
      );
      const body = results.map<HealthResponse[number]>((result, index) => ({
        name: checks[index]!.name,
        status: result.status === 'fulfilled' ? 'ok' : 'error',
      }));
      const failed = results.some((result) => result.status === 'rejected');
      return json(failed ? 503 : 200, body, failed ? { 'retry-after': '5' } : {});
    },
    env.PUBLIC_ACCESS_ENABLED === 'true' ? ready : undefined,
  );
}

export const handler = createHealthHandler();
