import type { Context } from 'aws-lambda';
import type { HttpEvent } from '../src/http.ts';

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
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
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
      routeKey: `${method} ${path}`,
      stage: 'local',
      time: '',
      timeEpoch: 0,
    },
  };
}
