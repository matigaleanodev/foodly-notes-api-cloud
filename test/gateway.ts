import type { Context } from 'aws-lambda';
import type { HttpEvent } from '../src/http/middleware.ts';
import { recipeRoutes, methodsFor } from '../src/http/routes.ts';
import { createRecipeHandler } from '../src/recipes/handler.ts';
import type { Database } from '../src/runtime/database.ts';
import type { Providers } from '../src/recipes/providers/client.ts';

/** Simula solamente la selección de integración de Gateway; no forma parte de ningún bundle. */
export function createRecipesHandler(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  provider?: Providers,
  factory = createRecipeHandler,
) {
  const handlers = new Map<string, ReturnType<typeof createRecipeHandler>>(
    recipeRoutes.flatMap((route) => {
      const handler = factory(route, db, env, provider);
      return methodsFor(route).map((method) => [`${method} ${route.path}`, handler] as const);
    }),
  );
  return async (request: HttpEvent, context: Context) => {
    const handler = handlers.get(request.routeKey);
    if (!handler) return { statusCode: 404, body: JSON.stringify({ message: 'Not Found' }) };
    return handler(request, context);
  };
}
