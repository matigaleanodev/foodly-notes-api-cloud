import { describe, expect, it, vi } from 'vitest';
import { cloudflareVisitor, trustedOrigin } from '../packages/runtime/src/http/ingress.ts';
import { http, json } from '../packages/runtime/src/http/middleware.ts';
import { configuration } from '@foodly-notes/contracts/configuration';
import { routes } from '@foodly-notes/contracts/routes';
import { context, env, event } from './helpers.ts';

function request(source = '173.245.48.1') {
  const value = event('/api/recipes', '', source);
  value.requestContext.domainName = 'api.foodlynotes.app';
  value.requestContext.stage = '$default';
  value.headers['cf-connecting-ip'] = '198.51.100.7';
  value.headers['x-foodly-origin'] = 's'.repeat(48);
  return value;
}

describe('Acceso productivo desde Cloudflare', () => {
  it('acepta IPv4/IPv6 Cloudflare y rechaza origen, dominio, stage e IP falsos', () => {
    expect(cloudflareVisitor(request())).toBe('198.51.100.7');
    expect(cloudflareVisitor(request('2606:4700::1'))).toBe('198.51.100.7');
    expect(cloudflareVisitor(request('198.51.100.1'))).toBeUndefined();
    for (const ip of ['invalid', '198.51.100.7,198.51.100.8']) {
      const value = request();
      value.headers['cf-connecting-ip'] = ip;
      expect(cloudflareVisitor(value)).toBeUndefined();
    }
    const direct = request();
    direct.requestContext.domainName = '3ieg72192e.execute-api.us-east-1.amazonaws.com';
    expect(cloudflareVisitor(direct)).toBeUndefined();
    const stage = request();
    stage.requestContext.stage = 'other';
    expect(cloudflareVisitor(stage)).toBeUndefined();
    expect(trustedOrigin('s'.repeat(48), 's'.repeat(48))).toBe(true);
    expect(trustedOrigin('s'.repeat(47), 's'.repeat(48))).toBe(false);
    expect(trustedOrigin('x'.repeat(48), 's'.repeat(48))).toBe(false);
    expect(trustedOrigin(undefined, 's'.repeat(48))).toBe(false);
    expect(trustedOrigin('short', 'short')).toBe(false);
  });
  it('entrega el visitante verificado a cuotas, ignora forwarding y rechaza antes del negocio', async () => {
    const work = vi.fn(async (value: ReturnType<typeof event>) =>
      json(200, value.requestContext.http.sourceIp),
    );
    const load = vi.fn(async () => ({ ORIGIN_VERIFY_SECRET: 's'.repeat(48) }));
    const handler = http(routes.recipes, configuration(env), work, load);
    const value = request();
    value.headers['x-forwarded-for'] = '1.1.1.1';
    expect((await handler(value, context)).body).toBe('"198.51.100.7"');
    expect((await handler(request('198.51.100.1'), context)).statusCode).toBe(403);
    const wrong = request();
    wrong.headers['x-foodly-origin'] = 'x'.repeat(48);
    expect((await handler(wrong, context)).statusCode).toBe(403);
    expect(work).toHaveBeenCalledTimes(1);
    const unavailable = http(routes.recipes, configuration(env), work, async () => {
      throw new Error('private');
    });
    expect(await unavailable(request(), context)).toMatchObject({
      statusCode: 503,
      headers: { 'retry-after': '5' },
    });
    const head = request();
    head.routeKey = 'HEAD /api/recipes';
    head.requestContext.http.method = 'HEAD';
    expect((await handler(head, context)).body).toBe('');
  });
});
