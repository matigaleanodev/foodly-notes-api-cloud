import { AsyncLocalStorage } from 'node:async_hooks';

export const requestLogContext = new AsyncLocalStorage<{ requestId: string }>();

export class RequestCancellation extends Error {
  constructor(readonly reason: 'deadline' | 'lambda_margin' | 'completed' | 'axios_timeout') {
    super('Request cancelled.');
  }
}
