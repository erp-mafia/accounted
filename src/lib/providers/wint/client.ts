import { fetchInExecutionBudget } from '@/lib/http/execution-budget';
import { TokenBucketRateLimiter, connectionRateKey } from '../rate-limiter';
import { withRetry } from '../retry';
import { WINT_BASE_URL, WINT_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';
import { cleanProviderPayload } from '../provider-text';

// Per attempt, sized for one record. The migration worker passes its own for
// whole register pages (MIGRATION_LIST_TIMEOUT_MS in provider-data-fetcher.ts).
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

const BASIC_PREFIX = 'Basic ';

/**
 * The stored credential of a WINT app ("Egen app" under Inställningar >
 * Integrationer in WINT): its username and API key as HTTP Basic, the scheme
 * the API itself names (`WWW-Authenticate: Basic realm="Wint.se"` on a request
 * without credentials, probed 2026-11-24). The customer creates the app inside
 * WINT, it carries no expiry and they switch it off there. Not yet seen
 * working against a live WINT app: the first real connection is the proof.
 * Kept in the access-token slot with its scheme so the client can tell it
 * from a login JWT, which never starts with "Basic ".
 */
export function wintAppCredential(username: string, apiKey: string): string {
  return `${BASIC_PREFIX}${Buffer.from(`${username}:${apiKey}`, 'utf8').toString('base64')}`;
}

export class WintClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? WINT_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(WINT_RATE_LIMIT, 'ratelimit:wint');
  }

  // Two credentials reach this client. An app credential (wintAppCredential)
  // is sent as it is stored. A connection made before those holds a JWT from
  // the account's login, which travels as a Bearer token: the API answers a
  // bad one with `WWW-Authenticate: Bearer error="invalid_token"` (probed
  // 2026-11-24), no live account has proven a good one.
  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: accessToken.startsWith(BASIC_PREFIX) ? accessToken : `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async get<T>(accessToken: string, path: string, options: { timeoutMs?: number } = {}): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire(connectionRateKey(accessToken));
        const response = await fetchInExecutionBudget(`${this.baseUrl}${path}`, {
          headers: this.authHeaders(accessToken),
          signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new WintApiError(
            `WINT API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return cleanProviderPayload(await response.json()) as T;
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
    options?: { page?: number; pageSize?: number; timeoutMs?: number },
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
      { timeoutMs: options?.timeoutMs },
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
