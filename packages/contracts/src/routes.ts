import { healthResponseSchema } from './health.ts';
import { ingredientsRequestSchema } from './ingredients.ts';
import {
  storedRecipesQuerySchema,
  recipeLangQuerySchema,
  searchRecipesQuerySchema,
  recipePathSchema,
} from './recipes.ts';

import {
  storedRecipesResponseSchema,
  dailyRecipesResponseSchema,
  searchRecipesResponseSchema,
  recipeDetailResponseSchema,
  similarRecipesResponseSchema,
  ingredientsResponseSchema,
} from './responses.ts';
import {
  commonErrorResponses,
  recipeErrorResponses,
  providerErrorResponses,
  response,
  retryHeaders,
  quotaResponseHeaders,
  httpErrorSchemas,
} from './http.ts';
import {
  storedRecipesHttpQuerySchema,
  recipeLangHttpQuerySchema,
  searchRecipesHttpQuerySchema,
  recipeHttpPathSchema,
  ingredientsHttpRequestSchema,
} from './http-input.ts';

export const routes = {
  health: {
    method: 'GET',
    path: '/api/health',
    group: 'health',
    operation: 'getHealth',
    responses: {
      ...commonErrorResponses,
      200: response(healthResponseSchema, 'Checks independientes correctos.'),
      503: response(healthResponseSchema, 'Uno o ambos checks fallaron.', retryHeaders),
    },
  },
  recipes: {
    method: 'GET',
    path: '/api/recipes',
    group: 'catalog',
    operation: 'getAllRecipes',
    request: { query: storedRecipesQuerySchema },
    httpInput: { query: storedRecipesHttpQuerySchema },
    responses: {
      ...recipeErrorResponses,
      200: response(
        storedRecipesResponseSchema,
        'Listado persistido ordenado, títulos base y cursor exclusivo.',
        quotaResponseHeaders,
      ),
    },
  },
  daily: {
    method: 'GET',
    path: '/api/recipes/daily',
    group: 'catalog',
    operation: 'getDailyRecipes',
    request: { query: recipeLangQuerySchema },
    httpInput: { query: recipeLangHttpQuerySchema },
    responses: {
      ...providerErrorResponses,
      200: response(
        dailyRecipesResponseSchema,
        'Selección UTC persistida, hasta 12, traducción con fallback base.',
        quotaResponseHeaders,
      ),
    },
  },
  search: {
    method: 'GET',
    path: '/api/recipes/search',
    group: 'catalog',
    operation: 'searchRecipes',
    request: { query: searchRecipesQuerySchema },
    httpInput: { query: searchRecipesHttpQuerySchema },
    responses: {
      ...providerErrorResponses,
      200: response(
        searchRecipesResponseSchema,
        'Hasta 12 resultados; títulos del proveedor e imagen string/null.',
        quotaResponseHeaders,
      ),
    },
    limit: 20,
  },
  detail: {
    method: 'GET',
    path: '/api/recipes/{id}',
    group: 'detail',
    operation: 'getRecipeDetails',
    responses: {
      ...providerErrorResponses,
      200: response(
        recipeDetailResponseSchema,
        'Detalle saneado, metadatos opcionales/null y lang efectivo.',
        quotaResponseHeaders,
      ),
    },
    request: { path: recipePathSchema, query: recipeLangQuerySchema },
    httpInput: { path: recipeHttpPathSchema, query: recipeLangHttpQuerySchema },
  },
  similar: {
    method: 'GET',
    path: '/api/recipes/{id}/similar',
    group: 'detail',
    operation: 'getSimilarRecipes',
    responses: {
      ...providerErrorResponses,
      200: response(
        similarRecipesResponseSchema,
        'Hasta 6 resúmenes; traducción con fallback base.',
        quotaResponseHeaders,
      ),
    },
    request: { path: recipePathSchema, query: recipeLangQuerySchema },
    httpInput: { path: recipeHttpPathSchema, query: recipeLangHttpQuerySchema },
    limit: 20,
  },
  ingredients: {
    method: 'POST',
    path: '/api/recipes/ingredients',
    group: 'ingredients',
    operation: 'getIngredients',
    request: { body: ingredientsRequestSchema },
    httpInput: { body: ingredientsHttpRequestSchema },
    responses: {
      ...providerErrorResponses,
      201: response(
        ingredientsResponseSchema,
        'Ingredientes por receta en orden solicitado, sin agregación ni lang en salida.',
        quotaResponseHeaders,
      ),
      413: response(httpErrorSchemas[413], 'JSON mayor de 16384 bytes.'),
      415: response(httpErrorSchemas[415], 'Content-Type inválido.'),
    },
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
