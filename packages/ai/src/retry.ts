/** Delay between provider retries; resolves early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** Parse a Retry-After header (seconds or HTTP date), capped at 30s. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return 1000;
}
