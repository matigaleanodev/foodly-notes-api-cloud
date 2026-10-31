import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { Agent } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { requestLogContext, RequestCancellation } from './request-context.ts';

export const HTTP_TIMEOUT_MS = 30000;

export const MAX_REQUEST_BYTES = 256 * 1024;

export const MAX_RESPONSE_BYTES = 1024 * 1024;

type HttpClientErrorCode =
  | 'HTTP_STATUS'
  | 'NETWORK'
  | 'INVALID_JSON'
  | 'REQUEST_SIZE'
  | 'RESPONSE_SIZE'
  | 'INVALID_URL'
  | 'TIMEOUT'
  | 'CANCELLED';

export class JsonHttpError extends Error {
  constructor(
    readonly code: HttpClientErrorCode,
    readonly status?: number,
  ) {
    super('External HTTP request failed.');
  }
}

export interface JsonRequest {
  provider: 'spoonacular' | 'azure';
  operation: 'detail' | 'details' | 'daily' | 'search' | 'similar' | 'translate';
  method: 'GET' | 'POST';
  signal: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  summary?: { items: number; characters?: number; language?: 'en' | 'es' };
}

export type JsonHttpClient = (url: URL, request: JsonRequest) => Promise<unknown>;

const networkCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_BAD_RESPONSE',
  'ERR_BAD_REQUEST',
  'ERR_CANCELED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/** Solo construye campos permitidos; nunca serializa objetos o mensajes de Axios. */
function logFailure(
  url: URL,
  request: JsonRequest,
  error: JsonHttpError,
  started: number,
  signal: AbortSignal,
  networkCode: string | undefined,
  responseBytes: number | undefined,
  responseType: unknown,
  retryAfter: unknown,
  logger: (event: string) => void,
) {
  try {
    const parameters: Record<string, string> = {};
    for (const key of ['number', 'addRecipeInformation', 'api-version', 'to']) {
      const value = url.searchParams.get(key);
      if (value && /^(?:[0-9]{1,3}|true|false|3\.0|en|es)$/.test(value)) parameters[key] = value;
    }
    const contentType = (value: unknown) =>
      typeof value === 'string' && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value)
        ? 'application/json'
        : undefined;
    const summary = request.summary;
    const count = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, 1000000)
        : undefined;
    const event = JSON.stringify({
      event: 'external_http_error',
      requestId: requestLogContext.getStore()?.requestId,
      provider: request.provider,
      operation: request.operation,
      method: request.method,
      destination:
        !isIP(url.hostname.replace(/^\[|\]$/g, '')) && /^[a-z0-9.-]{1,253}$/i.test(url.hostname)
          ? `https://${url.hostname}`
          : 'https://[redacted]',
      status: error.status ?? null,
      code: error.code,
      networkCode: networkCode && networkCodes.has(networkCode) ? networkCode : undefined,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      cancellation: signal.aborted
        ? signal.reason instanceof RequestCancellation
          ? signal.reason.reason
          : 'caller'
        : error.code === 'TIMEOUT'
          ? 'axios_timeout'
          : undefined,
      parameters,
      headers: {
        requestContentType: contentType(request.headers?.['Content-Type']),
        responseContentType: contentType(responseType),
        retryAfter:
          typeof retryAfter === 'string' && /^[0-9]{1,6}$/.test(retryAfter)
            ? retryAfter
            : undefined,
      },
      body: {
        requestBytes: Buffer.byteLength(request.body ?? ''),
        responseBytes,
        items: count(summary?.items),
        characters: count(summary?.characters),
        language:
          summary?.language === 'en' || summary?.language === 'es' ? summary.language : undefined,
      },
    });
    if (Buffer.byteLength(event) <= 2048) logger(event);
  } catch {
    // Un logger defectuoso no puede modificar respuestas ni fallbacks.
  }
}

/** JSON acotado sobre el adaptador HTTP de Node; sin fallback de transporte. */
export function createJsonHttpClient(
  logger: (event: string) => void = (event) => console.error(event),
  httpsAgent?: Agent,
): JsonHttpClient {
  const client = axios.create({
    adapter: 'http',
    httpsAgent,
    timeout: HTTP_TIMEOUT_MS,
    maxRedirects: 0,
    maxBodyLength: MAX_REQUEST_BYTES,
    maxContentLength: MAX_RESPONSE_BYTES,
    responseType: 'stream',
    transformResponse: [],
    validateStatus: () => true,
    transitional: { clarifyTimeoutError: true },
    // Evita que variables de proxy cambien el destino validado de los proveedores.
    proxy: false,
  });
  return async (url, request) => {
    const started = performance.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    // Acota también el tiempo total de un body que sigue entregando fragmentos.
    const timer = setTimeout(
      () => controller.abort(new RequestCancellation('axios_timeout')),
      HTTP_TIMEOUT_MS,
    );
    timer.unref();
    let stream: Readable | undefined;
    let status: number | undefined;
    let responseBytes: number | undefined;
    let responseType: unknown;
    let retryAfter: unknown;
    let networkCode: string | undefined;
    try {
      signal.throwIfAborted();
      if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new JsonHttpError('INVALID_URL');
      if (Buffer.byteLength(request.body ?? '') > MAX_REQUEST_BYTES)
        throw new JsonHttpError('REQUEST_SIZE');
      const config: AxiosRequestConfig<string> = {
        url: url.href,
        method: request.method,
        headers: request.headers,
        data: request.body,
        signal,
      };
      const response = await client.request<unknown, AxiosResponse<unknown, string>, string>(
        config,
      );
      status = response.status;
      responseType = response.headers['content-type'];
      retryAfter = response.headers['retry-after'];
      if (!(response.data instanceof Readable)) throw new JsonHttpError('INVALID_JSON', status);
      stream = response.data;
      // También puede fallar al abortar antes de comenzar a leer un error HTTP.
      stream.on('error', () => undefined);
      if (status < 200 || status >= 300) throw new JsonHttpError('HTTP_STATUS', status);
      if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES)
        throw new JsonHttpError('RESPONSE_SIZE', status);
      const chunks: Buffer[] = [];
      responseBytes = 0;
      for await (const value of stream) {
        signal.throwIfAborted();
        const chunk: unknown = value;
        if (!Buffer.isBuffer(chunk)) throw new JsonHttpError('INVALID_JSON', status);
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new JsonHttpError('RESPONSE_SIZE', status);
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return value;
      } catch {
        throw new JsonHttpError('INVALID_JSON', status);
      }
    } catch (cause) {
      if (axios.isAxiosError<unknown, string>(cause)) {
        networkCode = cause.code;
        status ??= cause.response?.status;
      }
      const error =
        cause instanceof JsonHttpError
          ? cause
          : new JsonHttpError(
              signal.aborted
                ? signal.reason instanceof RequestCancellation &&
                  signal.reason.reason === 'axios_timeout'
                  ? 'TIMEOUT'
                  : 'CANCELLED'
                : axios.isAxiosError(cause) &&
                    cause.message === `maxContentLength size of ${MAX_RESPONSE_BYTES} exceeded`
                  ? 'RESPONSE_SIZE'
                  : networkCode === 'ETIMEDOUT' || networkCode === 'ECONNABORTED'
                    ? 'TIMEOUT'
                    : 'NETWORK',
              status,
            );
      logFailure(
        url,
        request,
        error,
        started,
        signal,
        networkCode,
        responseBytes,
        responseType,
        retryAfter,
        logger,
      );
      throw error;
    } finally {
      clearTimeout(timer);
      stream?.destroy();
      controller.abort(new RequestCancellation('completed'));
    }
  };
}
