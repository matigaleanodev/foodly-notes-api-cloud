export interface Configuration {
  origins: string[];
  production: boolean;
  routeLimit: number;
  globalLimit: number;
}

export function configuration(env: NodeJS.ProcessEnv = process.env): Configuration {
  const production = env.NODE_ENV === 'production';
  const origins = (env.CORS_ORIGIN ?? (production ? '' : 'http://localhost:8100'))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length || origins.includes('*')) throw new Error('Explicit CORS_ORIGIN required.');
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      !['http:', 'https:', 'capacitor:'].includes(url.protocol) ||
      url.host.includes('*') ||
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      throw new Error('Invalid CORS origin.');
    }
  }
  return {
    origins,
    production,
    routeLimit: positiveSetting(env.RATE_LIMIT_PER_ROUTE, 30),
    globalLimit: positiveSetting(env.RATE_LIMIT_GLOBAL, 120),
  };
}

function positiveSetting(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error('Limits must be positive safe integers.');
  }
  return Number(value);
}
