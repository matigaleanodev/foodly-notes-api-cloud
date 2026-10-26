export const routes = {
  health: { method: 'GET', path: '/api/health' },
  recipes: { method: 'GET', path: '/api/recipes', handler: 'list', operation: 'getAllRecipes' },
  daily: {
    method: 'GET',
    path: '/api/recipes/daily',
    handler: 'daily',
    operation: 'getDailyRecipes',
  },
  search: {
    method: 'GET',
    path: '/api/recipes/search',
    handler: 'search',
    operation: 'searchRecipes',
    limit: 20,
  },
  detail: {
    method: 'GET',
    path: '/api/recipes/{id}',
    handler: 'detail',
    operation: 'getRecipeDetails',
  },
  similar: {
    method: 'GET',
    path: '/api/recipes/{id}/similar',
    handler: 'similar',
    operation: 'getSimilarRecipes',
    limit: 20,
  },
  ingredients: {
    method: 'POST',
    path: '/api/recipes/ingredients',
    handler: 'ingredients',
    operation: 'getIngredients',
    limit: 10,
  },
} as const;

export type Route = (typeof routes)[keyof typeof routes];

export const recipeRoutes = [
  routes.recipes,
  routes.daily,
  routes.search,
  routes.detail,
  routes.similar,
  routes.ingredients,
];

export type RecipeRoute = (typeof recipeRoutes)[number];

export function methodsFor(route: Route): ('GET' | 'POST' | 'HEAD')[] {
  return route.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
}

export function eventsFor(route: Route) {
  return methodsFor(route).map((method) => ({ httpApi: { method, path: route.path } }));
}
