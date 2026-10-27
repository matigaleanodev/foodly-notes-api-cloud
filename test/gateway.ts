import { expectResponseContract } from './response-contract.ts';
import type { Context } from 'aws-lambda';
import type { HttpEvent } from '../src/http/middleware.ts';
import { recipeGroups, recipeRoutes, methodsFor } from '../src/http/routes.ts';
import { createRecipeGroupHandler } from '../src/recipes/handler.ts';
import type { Database } from '../src/runtime/database.ts';
import type { Providers } from '../src/recipes/providers/client.ts';

/** Simula Gateway entre grupos; cada grupo ejecuta la selección de operaciones de producción. */
export function createRecipesHandler(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  provider?: Providers,
) {
  const groups = Object.fromEntries(
    recipeGroups.map((group) => [group, createRecipeGroupHandler(group, db, env, provider)]),
  );
  const handlers = new Map<string, ReturnType<typeof createRecipeGroupHandler>>(
    recipeRoutes.flatMap((route) =>
      methodsFor(route).map((method) => [`${method} ${route.path}`, groups[route.group]!] as const),
    ),
  );
  return async (request: HttpEvent, context: Context) => {
    const handler = handlers.get(request.routeKey);
    if (!handler) return { statusCode: 404, body: JSON.stringify({ message: 'Not Found' }) };
    const result = await handler(request, context);
    const route = recipeRoutes.find((candidate) =>
      methodsFor(candidate).some((method) => request.routeKey === `${method} ${candidate.path}`),
    )!;
    expectResponseContract(route, result, request.requestContext.http.method);
    return result;
  };
}
