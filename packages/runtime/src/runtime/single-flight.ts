import { HttpError } from '../http/middleware.ts';

/** Comparte trabajos pendientes por clave en una instancia; no coordina otras Lambdas. */
export class SingleFlight<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  run(key: K, work: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 64) {
      return Promise.reject(
        new HttpError(503, 'Service busy. Retry later.', 'Service Unavailable', {
          'retry-after': '5',
        }),
      );
    }
    const promise = Promise.resolve()
      .then(work)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
