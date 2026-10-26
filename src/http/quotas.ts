import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import type { Database } from '../runtime/database.ts';
import type { Configuration } from '../runtime/config.ts';
import { HttpError } from './middleware.ts';

export function tracker(ip: string) {
  const address = ipaddr.process(ip);
  if (address.kind() === 'ipv4' || address.toString() === '::1') return address.toString();
  return `${ipaddr.IPv6.networkAddressFromCIDR(`${address.toString()}/64`).toString()}/64`;
}

export async function quota(db: Database, ip: string, config: Configuration, signal: AbortSignal) {
  const now = Date.now();
  const expiresAt = new Date((Math.floor(now / 60000) + 1) * 60000);
  const retry = String(Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const client = tracker(ip);
  // Las mismas claves que Nest permiten compartir ventanas durante recuperación/corte.
  const limits = [
    {
      key: hash(`RecipesController-getAllRecipes-default-${client}`),
      limit: config.routeLimit,
      suffix: '',
    },
    { key: hash(`global:${client}`), limit: config.globalLimit, suffix: '-global' },
  ];
  const headers: Record<string, string> = {};
  for (const { key, limit, suffix } of limits) {
    let count: number;
    try {
      count = await db.increment(`throttle:${key}:${Math.floor(now / 60000)}`, expiresAt, signal);
    } catch {
      throw new HttpError(503, 'Request limit verification unavailable.', 'Service Unavailable', {
        'retry-after': '5',
      });
    }
    if (count > limit) {
      throw new HttpError(429, 'ThrottlerException: Too Many Requests', undefined, {
        'retry-after': retry,
      });
    }
    headers[`x-ratelimit-limit${suffix}`] = String(limit);
    headers[`x-ratelimit-remaining${suffix}`] = String(Math.max(0, limit - count));
    headers[`x-ratelimit-reset${suffix}`] = retry;
  }
  return headers;
}
