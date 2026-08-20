import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { FORTNOX_BASE_URL, FORTNOX_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;

export class FortnoxApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FortnoxApiError';
  }
}

/**
 * Human-readable message from a Fortnox error body
 * ({"ErrorInformation":{"error":1,"message":"...","code":2000423}}), or null
 * when the body is empty or not in that shape.
 */
export function fortnoxErrorMessage(error: unknown): string | null {
  if (!(error instanceof FortnoxApiError) || !error.body) return null;
  try {
    const parsed = JSON.parse(error.body) as {
      ErrorInformation?: { message?: unknown; Message?: unknown };
      message?: unknown;
    };
    const message =
      parsed?.ErrorInformation?.message ?? parsed?.ErrorInformation?.Message ?? parsed?.message;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : null;
  } catch {
    const text = error.body.trim();
    return text ? text.slice(0, 300) : null;
  }
}

/**
 * Missing scope or licence. Fortnox documents 403 for failed authorisation,
 * but live answers for an unlicensed/unscoped resource have also come back
 * as 400 with a behörighet/scope/licens message, so both are recognised.
 */
export function isFortnoxPermissionError(error: unknown): error is FortnoxApiError {
  if (!(error instanceof FortnoxApiError)) return false;
  if (error.statusCode === 403) return true;
  if (error.statusCode !== 400) return false;
  const text = `${error.body ?? ''} ${fortnoxErrorMessage(error) ?? ''}`;
  return /beh[öo]righet|scope|licens|licence|license|permission|unauthori[sz]ed/i.test(text);
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof FortnoxApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

export class FortnoxClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? FORTNOX_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(FORTNOX_RATE_LIMIT, 'ratelimit:fortnox');
  }

  async get<T>(accessToken: string, path: string): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          let retryAfterMs: number | undefined;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            retryAfterMs = retryAfter ? Math.ceil(parseFloat(retryAfter)) * 1000 : undefined;
          }
          throw new FortnoxApiError(
            `Fortnox API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
            retryAfterMs,
          );
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: 6,
        initialDelayMs: 2000,
        maxDelayMs: 60_000,
        shouldRetry: isRetryableError,
        getDelayMs: (error) => {
          if (error instanceof FortnoxApiError && error.retryAfterMs) {
            return error.retryAfterMs;
          }
          return undefined;
        },
      },
    );
  }

  async getText(accessToken: string, path: string): Promise<string> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          let retryAfterMs: number | undefined;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            retryAfterMs = retryAfter ? Math.ceil(parseFloat(retryAfter)) * 1000 : undefined;
          }
          throw new FortnoxApiError(
            `Fortnox API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
            retryAfterMs,
          );
        }

        return response.text();
      },
      {
        maxAttempts: 6,
        initialDelayMs: 2000,
        maxDelayMs: 60_000,
        shouldRetry: isRetryableError,
        getDelayMs: (error) => {
          if (error instanceof FortnoxApiError && error.retryAfterMs) {
            return error.retryAfterMs;
          }
          return undefined;
        },
      },
    );
  }

  /**
   * Fetch a binary resource with the same rate-limit/retry behavior as get().
   * Used for the SIE export: response.text() would blind-decode as UTF-8 and
   * irrecoverably turn CP437 å/ä/ö into U+FFFD, so callers must run the raw
   * bytes through detectEncoding()/decodeBuffer() (mirrors Briox/BL clients).
   */
  async getBytes(accessToken: string, path: string): Promise<ArrayBuffer> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          let retryAfterMs: number | undefined;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            retryAfterMs = retryAfter ? Math.ceil(parseFloat(retryAfter)) * 1000 : undefined;
          }
          throw new FortnoxApiError(
            `Fortnox API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
            retryAfterMs,
          );
        }

        return response.arrayBuffer();
      },
      {
        maxAttempts: 6,
        initialDelayMs: 2000,
        maxDelayMs: 60_000,
        shouldRetry: isRetryableError,
        getDelayMs: (error) => {
          if (error instanceof FortnoxApiError && error.retryAfterMs) {
            return error.retryAfterMs;
          }
          return undefined;
        },
      },
    );
  }

  /**
   * Fetch a binary resource and retain its declared content type.
   * Attachment import needs both the raw bytes and the response metadata.
   */
  async getBinary(
    accessToken: string,
    path: string,
  ): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          let retryAfterMs: number | undefined;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            retryAfterMs = retryAfter ? Math.ceil(parseFloat(retryAfter)) * 1000 : undefined;
          }
          throw new FortnoxApiError(
            `Fortnox API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
            retryAfterMs,
          );
        }

        return {
          bytes: await response.arrayBuffer(),
          contentType: response.headers.get('Content-Type'),
        };
      },
      {
        maxAttempts: 6,
        initialDelayMs: 2000,
        maxDelayMs: 60_000,
        shouldRetry: isRetryableError,
        getDelayMs: (error) => {
          if (error instanceof FortnoxApiError && error.retryAfterMs) {
            return error.retryAfterMs;
          }
          return undefined;
        },
      },
    );
  }

  async getPage<T>(
    accessToken: string,
    path: string,
    listKey: string,
    options?: { page?: number; pageSize?: number; lastModified?: string },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    const params = new URLSearchParams();
    params.set('page', String(options?.page ?? 1));
    if (options?.pageSize) {
      params.set('limit', String(options.pageSize));
    }
    if (options?.lastModified) {
      params.set('lastmodified', options.lastModified);
    }

    const separator = path.includes('?') ? '&' : '?';
    const fullPath = `${path}${separator}${params.toString()}`;

    const response = await this.get<Record<string, unknown>>(accessToken, fullPath);

    const meta = response['MetaInformation'] as
      | { '@TotalPages': number; '@CurrentPage': number; '@TotalResources': number }
      | undefined;

    const totalPages = meta?.['@TotalPages'] ?? 1;
    const currentPage = meta?.['@CurrentPage'] ?? 1;
    const totalCount = meta?.['@TotalResources'] ?? 0;

    const items = response[listKey];
    return {
      items: Array.isArray(items) ? (items as T[]) : [],
      page: currentPage,
      totalPages,
      totalCount,
    };
  }

  async getPaginated<T>(
    accessToken: string,
    path: string,
    listKey: string,
    options?: { lastModified?: string; pageSize?: number },
  ): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const result = await this.getPage<T>(accessToken, path, listKey, {
        page,
        pageSize: options?.pageSize,
        lastModified: options?.lastModified,
      });

      allItems.push(...result.items);
      totalPages = result.totalPages;
      page++;
    } while (page <= totalPages);

    return allItems;
  }
}
