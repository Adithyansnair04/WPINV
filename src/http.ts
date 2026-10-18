export type ErrorCategory = 'auth' | 'rate_limit' | 'transient' | 'client' | 'validation' | 'timeout';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RetryStats {
  retries: number;
  rateLimited: number;
}

export interface RetryOptions {
  timeoutMs: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  stats?: RetryStats;
  /** Decide whether a non-2xx response should be retried. Defaults to 429 and 5xx. */
  retryable?: (res: Response, body: string) => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

export function categorize(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'client';
}

/** fetch with timeout, exponential backoff with jitter, and Retry-After support. Returns the final response and its body text. */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<{ res: Response; body: string }> {
  const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 20000, stats } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.sleep ?? sleep;
  const retryable = opts.retryable ?? ((res) => res.status === 429 || res.status >= 500);
  let attempt = 0;
  for (;;) {
    let delay: number | undefined;
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      const body = res.headers.get('content-type')?.includes('application/pdf') ? '' : await res.clone().text();
      if (res.ok || !retryable(res, body) || attempt >= maxRetries) return { res, body };
      if (res.status === 429 && stats) stats.rateLimited++;
      delay = retryAfterMs(res);
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (attempt >= maxRetries) {
        throw new HttpError(isTimeout ? `Request timed out after ${opts.timeoutMs}ms` : `Network error: ${(err as Error).message}`, isTimeout ? 'timeout' : 'transient');
      }
    }
    attempt++;
    if (stats) stats.retries++;
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
    await wait(Math.min(maxDelayMs, delay ?? backoff));
  }
}
