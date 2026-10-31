import type { Context } from 'aws-lambda';
import type { HttpEvent } from '../packages/runtime/src/http/middleware.ts';

import { routes, methodsFor } from '@foodly-notes/contracts/routes';

export const env = { CORS_ORIGIN: 'https://foodlynotes.app,capacitor://localhost' };

export const context: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'local',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'local',
  memoryLimitInMB: '256',
  awsRequestId: 'local-test',
  logGroupName: 'local',
  logStreamName: 'local',
  getRemainingTimeInMillis: () => 10000,
  done() {},
  fail() {},
  succeed() {},
};

export function event(
  path = '/api/recipes',
  query = '',
  ip = '198.51.100.10',
  method = 'GET',
): HttpEvent {
  const matched = Object.values(routes).flatMap((route) => {
    const match = new RegExp('^' + route.path.replace('{id}', '(?<id>[^/]+)') + '/?$').exec(path);
    return match && methodsFor(route).some((candidate) => candidate === method)
      ? [{ route, params: match.groups }]
      : [];
  })[0];
  const routeKey = matched ? `${method} ${matched.route.path}` : '$default';
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    pathParameters: matched?.params,
    rawQueryString: query,
    headers: { origin: 'https://foodlynotes.app' },
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'local',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: ip, userAgent: 'local' },
      requestId: 'local',
      routeKey,
      stage: 'local',
      time: '',
      timeEpoch: 0,
    },
  };
}
