export const routes = {
  health: { method: 'GET', path: '/api/health', group: 'health' },
  recipes: { method: 'GET', path: '/api/recipes', group: 'catalog', operation: 'getAllRecipes' },
  daily: {
    method: 'GET',
    path: '/api/recipes/daily',
    group: 'catalog',
    operation: 'getDailyRecipes',
  },
  search: {
    method: 'GET',
    path: '/api/recipes/search',
    group: 'catalog',
    operation: 'searchRecipes',
    limit: 20,
  },
  detail: {
    method: 'GET',
    path: '/api/recipes/{id}',
    group: 'detail',
    operation: 'getRecipeDetails',
  },
  similar: {
    method: 'GET',
    path: '/api/recipes/{id}/similar',
    group: 'detail',
    operation: 'getSimilarRecipes',
    limit: 20,
  },
  ingredients: {
    method: 'POST',
    path: '/api/recipes/ingredients',
    group: 'ingredients',
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

export const recipeGroups = ['catalog', 'detail', 'ingredients'] as const;

export type RecipeGroup = (typeof recipeGroups)[number];

export function routesFor(group: RecipeGroup) {
  return recipeRoutes.filter((route) => route.group === group);
}

export function methodsFor(route: Route): ('GET' | 'POST' | 'HEAD')[] {
  return route.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
}
