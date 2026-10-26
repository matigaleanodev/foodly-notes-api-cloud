import { configuration } from '../runtime/config.ts';
import { http, json } from '../http/middleware.ts';
import { routes } from '../http/routes.ts';

export const createHealthHandler = (env: NodeJS.ProcessEnv = process.env) =>
  http(routes.health, configuration(env), async () => json(200, { status: 'ok' }));

export const handler = createHealthHandler();
