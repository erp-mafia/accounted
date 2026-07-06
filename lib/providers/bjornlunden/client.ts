import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { BL_BASE_URL, BL_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;
// The SIE export renders a whole fiscal year server-side (megabytes for an
// active company): give it more room than ordinary CRUD reads.
const SIE_FETCH_TIMEOUT_MS = 60_000;

export class BjornLundenApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'BjornLundenApiError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof BjornLundenApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

interface BLPaginatedResponse<T> {
  pageRequested: number;
  totalPages: number;
  totalRows: number;
  data: T[];
}

export interface BLFinancialYear {
  entityId: number;
  /** BL's period key, e.g. "202501" */
  id?: string;
  fromDate: string;
  toDate: string;
  open?: boolean;
}

export class BjornLundenClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BL_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(BL_RATE_LIMIT, 'ratelimit:bjornlunden');
  }

  /**
   * @param options.retry Set to false to fail fast on the first error instead
   *   of retrying. Used by credential probes, where a bad User-Key answers
   *   HTTP 500 (a "retryable" status) and would otherwise burn the full retry
   *   budget with backoff before reporting the bad key.
   */
  async get<T>(
    accessToken: string,
    userKey: string,
    path: string,
    options?: { retry?: boolean },
  ): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Key': userKey,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BjornLundenApiError(
            `Björn Lunden API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: options?.retry === false ? 1 : 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  async getPage<T>(
    accessToken: string,
    userKey: string,
    relativePath: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    // Sandbox-verified: the batch endpoints honor `page` and `rows`. The
    // response envelope echoes `pageRequested`, but a `pageRequested` REQUEST
    // param is silently ignored (as is `rowsRequested`): sending those would
    // re-fetch page 1 forever.
    const params = new URLSearchParams();
    params.set('page', String(options?.page ?? 1));
    params.set('rows', String(options?.pageSize ?? 50));

    const path = `${relativePath}?${params.toString()}`;
    const response = await this.get<BLPaginatedResponse<T>>(accessToken, userKey, path);

    return {
      items: Array.isArray(response.data) ? response.data : [],
      page: response.pageRequested ?? (options?.page ?? 1),
      totalPages: response.totalPages ?? 1,
      totalCount: response.totalRows ?? 0,
    };
  }

  async getAll<T>(accessToken: string, userKey: string, path: string): Promise<T[]> {
    const response = await this.get<T[] | BLPaginatedResponse<T>>(accessToken, userKey, path);
    if (Array.isArray(response)) {
      return response;
    }
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Fetch a binary resource with the same rate-limit/retry behavior as get().
   * Used for the SIE export, which BL serves as raw bytes
   * (Content-Type: text/vnd.sie-gruppen.si, typically CP437-encoded) despite
   * the swagger declaring a base64 string: callers must run the bytes
   * through detectEncoding()/decodeBuffer().
   */
  async getBytes(accessToken: string, userKey: string, path: string): Promise<ArrayBuffer> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Key': userKey,
          },
          signal: AbortSignal.timeout(SIE_FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BjornLundenApiError(
            `Björn Lunden API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return response.arrayBuffer();
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  /** All financial years registered in BL for the company behind the User-Key. */
  async listFinancialYears(accessToken: string, userKey: string): Promise<BLFinancialYear[]> {
    return this.getAll<BLFinancialYear>(accessToken, userKey, '/financialyear');
  }

  async getDetail<T>(accessToken: string, userKey: string, path: string): Promise<T> {
    return this.get<T>(accessToken, userKey, path);
  }
}
