import { configuration } from '../runtime/config.ts';
import { database, type Database } from '../runtime/database.ts';
import { http, json } from '../http/middleware.ts';
import { routes } from '../http/routes.ts';

/** Ejecuta checks independientes, acotados y sin escrituras; no expone errores internos. */
export function createHealthHandler(
  env: NodeJS.ProcessEnv = process.env,
  db: Pick<Database, 'ping'> = database(() => env.MONGO_URI, 1),
) {
  // Los middleware solo necesitan production; la configuración se valida dentro de su propio check.
  const middlewareConfig = {
    production: env.NODE_ENV === 'production',
    origins: [],
    routeLimit: 0,
    globalLimit: 0,
  };
  return http(routes.health, middlewareConfig, async (_event, context) => {
    const duration = Math.max(1, Math.min(2000, context.getRemainingTimeInMillis() - 500));
    const checks = [
      {
        name: 'configuration',
        work: async (_signal: AbortSignal) => {
          configuration(env);
        },
      },
      { name: 'mongo', work: (signal: AbortSignal) => db.ping(signal) },
    ];
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
    const body = results.map((result, index) => ({
      name: checks[index]!.name,
      status: result.status === 'fulfilled' ? 'ok' : 'error',
    }));
    const failed = results.some((result) => result.status === 'rejected');
    return json(failed ? 503 : 200, body, failed ? { 'retry-after': '5' } : {});
  });
}

export const handler = createHealthHandler();
