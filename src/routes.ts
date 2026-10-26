export const routes = {
  health: { method: 'GET', path: '/api/health' },
  recipes: { method: 'GET', path: '/api/recipes' },
} as const;

export type Route = (typeof routes)[keyof typeof routes];

export function eventsFor(route: Route) {
  return [route.method, 'HEAD'].map((method) => ({
    httpApi: { method, path: route.path },
  }));
}
