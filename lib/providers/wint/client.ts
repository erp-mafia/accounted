import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { WINT_BASE_URL, WINT_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;

// WINT error bodies can carry customer data, and provider errors get logged
// wholesale by callers (provider-data-fetcher). Keep only a short bounded
// diagnostic on the error object so a full response body never reaches logs.
const MAX_ERROR_BODY_CHARS = 300;

export class WintApiError extends Error {
  public readonly body?: string;

  constructor(message: string, public readonly statusCode: number, body?: string) {
    super(message);
    this.name = 'WintApiError';
    this.body = body != null ? body.slice(0, MAX_ERROR_BODY_CHARS) : undefined;
  }
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof WintApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

/**
 * Every WINT list endpoint answers the same envelope. `Page` echoes the page
 * that was actually served: the pagination loop keys on it (see getPaginated)
 * because we have no documentation guaranteeing the `Page` request param is
 * honored, and a provider that silently ignores it would otherwise loop on
 * page 1 forever (the exact failure mode Björn Lundén shipped with
 * pageRequested/rowsRequested).
 */
export interface WintListResponse<T> {
  Items: T[];
  Page: number;
  NumPerPage: number;
  TotalItems: number;
  TotalItemsWithOutFilter?: number;
}

const DEFAULT_PAGE_SIZE = 200;

export class WintClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? WINT_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(WINT_RATE_LIMIT, 'ratelimit:wint');
  }

  // Assumption (unverified against a live account, no securityScheme in the
  // swagger): the JWT from POST /api/Auth/jwt travels as a standard Bearer
  // token. If a live test proves otherwise the change is confined here.
  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async get<T>(accessToken: string, path: string): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: this.authHeaders(accessToken),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new WintApiError(
            `WINT API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  async getPage<T>(
    accessToken: string,
    path: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<{ items: T[]; page: number; totalItems: number; pageSize: number }> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;

    const params = new URLSearchParams();
    params.set('Page', String(page));
    params.set('NumPerPage', String(pageSize));
    const separator = path.includes('?') ? '&' : '?';

    const response = await this.get<WintListResponse<T>>(
      accessToken,
      `${path}${separator}${params.toString()}`,
    );

    return {
      items: Array.isArray(response.Items) ? response.Items : [],
      page: response.Page ?? page,
      totalItems: response.TotalItems ?? 0,
      pageSize: response.NumPerPage ?? pageSize,
    };
  }

  async getPaginated<T>(
    accessToken: string,
    path: string,
    options?: { pageSize?: number },
  ): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;

    for (;;) {
      const result = await this.getPage<T>(accessToken, path, {
        page,
        pageSize: options?.pageSize,
      });

      // Page-echo guard: a server that ignores the Page param serves page 1
      // for every request; without this check the loop appends the same items
      // until TotalItems is (never) reached.
      if (result.page !== page) {
        throw new WintApiError(
          `WINT pagination did not honor Page=${page} (served ${result.page}) for ${path}`,
          502,
        );
      }

      allItems.push(...result.items);

      const done =
        result.items.length === 0 ||
        allItems.length >= result.totalItems ||
        result.items.length < result.pageSize;
      if (done) break;
      page++;
    }

    return allItems;
  }
}
