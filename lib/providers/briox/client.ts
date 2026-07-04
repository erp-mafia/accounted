import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { BRIOX_BASE_URL, BRIOX_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;

export class BrioxApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'BrioxApiError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof BrioxApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

interface BrioxListResponse {
  data: Record<string, unknown> & {
    metainformation?: {
      total_pages: number;
      current_page: number;
      total_count: number;
    };
  };
}

export interface BrioxFinancialYear {
  id: string;
  fromdate: string;
  todate: string;
}

export class BrioxClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BRIOX_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(BRIOX_RATE_LIMIT, 'ratelimit:briox');
  }

  // The Authorization header carries the RAW access token: no "Bearer "
  // prefix. The swagger securityScheme is `apiKey` in header "Authorization"
  // (the Swagger UI pastes the bare token), not an OAuth bearer scheme.
  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async get<T>(accessToken: string, path: string): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: this.authHeaders(accessToken),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BrioxApiError(
            `Briox API error: ${response.status} ${response.statusText}`,
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

  /**
   * Fetch a binary resource (e.g. the SIE export, served as an octet-stream)
   * with the same rate-limit/retry behavior as get(). Returns the raw bytes:
   * SIE files must go through detectEncoding()/decodeBuffer() since Briox may
   * emit CP437, Windows-1252 or UTF-8.
   */
  async getBytes(accessToken: string, path: string): Promise<ArrayBuffer> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: { Authorization: accessToken },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BrioxApiError(
            `Briox API error: ${response.status} ${response.statusText}`,
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

  async getPage<T>(
    accessToken: string,
    path: string,
    listKey: string,
    options?: {
      page?: number;
      pageSize?: number;
      fromModifiedDate?: string;
    },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    const params = new URLSearchParams();
    params.set('page', String(options?.page ?? 1));
    if (options?.pageSize) {
      params.set('limit', String(options.pageSize));
    }
    if (options?.fromModifiedDate) {
      params.set('frommodifieddate', options.fromModifiedDate);
    }

    const separator = path.includes('?') ? '&' : '?';
    const fullPath = `${path}${separator}${params.toString()}`;

    const response = await this.get<BrioxListResponse>(accessToken, fullPath);

    const meta = response.data?.metainformation;
    const totalPages = meta?.total_pages ?? 1;
    const currentPage = meta?.current_page ?? (options?.page ?? 1);
    const totalCount = meta?.total_count ?? 0;

    const items = listKey ? response.data?.[listKey] : response.data;

    return {
      items: Array.isArray(items) ? items as T[] : [],
      page: currentPage,
      totalPages,
      totalCount,
    };
  }

  async getPaginated<T>(
    accessToken: string,
    path: string,
    listKey: string,
    options?: {
      fromModifiedDate?: string;
      pageSize?: number;
    },
  ): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const result = await this.getPage<T>(accessToken, path, listKey, {
        page,
        pageSize: options?.pageSize,
        fromModifiedDate: options?.fromModifiedDate,
      });

      allItems.push(...result.items);
      totalPages = result.totalPages;
      page++;
    } while (page <= totalPages);

    return allItems;
  }

  /** All financial years registered in Briox, oldest first (API order). */
  async listFinancialYears(accessToken: string): Promise<BrioxFinancialYear[]> {
    const response = await this.get<{
      data: {
        financialyears: BrioxFinancialYear[];
      };
    }>(accessToken, '/financialyear');

    return response.data?.financialyears ?? [];
  }

  async getCurrentFinancialYear(accessToken: string): Promise<string> {
    const years = await this.listFinancialYears(accessToken);
    if (years.length === 0) {
      throw new BrioxApiError('No financial years found in Briox', 404);
    }
    const now = new Date().toISOString().slice(0, 10);
    const completed = years.filter((y) => y.todate < now);
    return completed.length > 0 ? completed[completed.length - 1]!.id : years[0]!.id;
  }
}
