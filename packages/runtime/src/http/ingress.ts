import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { HttpEvent } from './middleware.ts';

// Rangos publicados en https://www.cloudflare.com/ips/; mantener junto al acceso de origen.
const cloudflare = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
].map((value) => ipaddr.parseCIDR(value));

export function cloudflareVisitor(event: HttpEvent): string | undefined {
  const source = event.requestContext.http.sourceIp;
  const visitor = event.headers['cf-connecting-ip'];
  if (
    !isIP(source) ||
    !visitor ||
    !isIP(visitor) ||
    event.requestContext.domainName !== 'api.foodlynotes.app' ||
    event.requestContext.stage !== '$default' ||
    ipaddr.subnetMatch(ipaddr.process(source), { cloudflare }, '') !== 'cloudflare'
  )
    return;
  return visitor;
}

export function trustedOrigin(actual: string | undefined, expected: string | undefined) {
  if (!actual || !expected || expected.length < 32) return false;
  const supplied = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}
