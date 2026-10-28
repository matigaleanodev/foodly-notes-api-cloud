import middy from '@middy/core';
import { cloudflareVisitor, trustedOrigin } from './ingress.ts';
import { requestLogContext } from '../runtime/request-context.ts';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Configuration } from '@foodly-notes/contracts/configuration';
import { methodsFor, type Route } from '@foodly-notes/contracts/routes';

export type HttpEvent = APIGatewayProxyEventV2;

export type HttpResult = APIGatewayProxyStructuredResultV2;

export type HttpHandler = (event: HttpEvent, context: Context) => Promise<HttpResult>;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string | string[],
    readonly label?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(typeof detail === 'string' ? detail : detail.join('; '));
  }
}

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResult {
  return {
    statusCode,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  };
}

/** Aplica el contrato HTTP común; los logs usan rutas declaradas y omiten payloads y consultas. */
export function http(
  route: Route,
  config: Configuration,
  handler: HttpHandler,
  load?: () => Promise<NodeJS.ProcessEnv>,
) {
  type Internal = { foodlyHttp: { requestId: string; started: number } };
  type Request = middy.Request<HttpEvent, HttpResult, Error, Context, Internal>;
  const requestIds = new WeakMap<HttpEvent, string>();
  const finish = (request: Request) => {
    const state = request.internal.foodlyHttp;
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'origin-agent-cluster': '?1',
      'x-dns-prefetch-control': 'off',
      'x-download-options': 'noopen',
      'x-permitted-cross-domain-policies': 'none',
      'x-xss-protection': '0',
      'content-security-policy':
        "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline'" +
        (config.production ? ';upgrade-insecure-requests' : ''),
      'x-request-id': state.requestId,
      vary: 'Origin',
    };
    if (config.production) headers['strict-transport-security'] = 'max-age=31536000';
    request.response = {
      ...request.response,
      headers: { ...headers, ...request.response?.headers },
    };
    if (request.event.requestContext.http.method === 'HEAD') request.response.body = '';
    console.info(
      JSON.stringify({
        requestId: state.requestId,
        route: route.path,
        statusCode: request.response.statusCode,
        durationMs: Math.round(performance.now() - state.started),
      }),
    );
  };
  return middy<HttpEvent, HttpResult, Error, Context, Internal>({ timeoutEarlyInMillis: 0 })
    .use({
      async before(request) {
        request.context.callbackWaitsForEmptyEventLoop = false;
        request.internal.foodlyHttp = { requestId: randomUUID(), started: performance.now() };
        const { event } = request;
        requestIds.set(event, request.internal.foodlyHttp.requestId);
        if (event.version !== '2.0' || !isIP(event.requestContext.http.sourceIp)) {
          throw new HttpError(403, 'Forbidden', 'Forbidden');
        }
        if (load) {
          const visitor = cloudflareVisitor(event);
          if (!visitor) throw new HttpError(403, 'Forbidden', 'Forbidden');
          let expected: string | undefined;
          try {
            expected = (await load()).ORIGIN_VERIFY_SECRET;
          } catch {
            throw new HttpError(503, 'Service unavailable.', 'Service Unavailable', {
              'retry-after': '5',
            });
          }
          if (!trustedOrigin(event.headers['x-foodly-origin'], expected))
            throw new HttpError(403, 'Forbidden', 'Forbidden');
          event.requestContext.http.sourceIp = visitor;
        }
        if (
          event.rawPath.length + (event.rawQueryString ? event.rawQueryString.length + 1 : 0) >
          4096
        ) {
          throw new HttpError(414, 'Request URL too long.');
        }
        // La ruta se resolvió en Gateway; se valida la integración sin volver a enrutar por URL.
        if (!methodsFor(route).some((method) => event.routeKey === `${method} ${route.path}`)) {
          throw new HttpError(
            404,
            `Cannot ${event.requestContext.http.method} ${event.rawPath}`,
            'Not Found',
          );
        }
      },
      after: finish,
      onError(request) {
        const error = request.error;
        request.response =
          error instanceof HttpError
            ? json(
                error.statusCode,
                {
                  statusCode: error.statusCode,
                  message: error.detail,
                  ...(error.label ? { error: error.label } : {}),
                },
                error.headers,
              )
            : json(500, { statusCode: 500, message: 'Internal server error' });
        finish(request);
      },
    })
    .handler((event, context) =>
      requestLogContext.run({ requestId: requestIds.get(event)! }, () => handler(event, context)),
    );
}
