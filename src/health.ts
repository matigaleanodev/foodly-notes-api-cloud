import { configuration } from './config.ts';
import { http, json } from './http.ts';
import { routes } from './routes.ts';

export const createHealthHandler = (env: NodeJS.ProcessEnv = process.env) =>
  http(routes.health, configuration(env), async () => json(200, { status: 'ok' }));

export const handler = createHealthHandler();
