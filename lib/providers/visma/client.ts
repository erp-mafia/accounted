import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { VISMA_BASE_URL, VISMA_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const FETCH_TIMEOUT_MS = 15_000;

export class VismaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'VismaApiError';
  }
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof VismaApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

interface VismaPaginatedResponse<T> {
  Meta?: { TotalNumberOfPages?: number };
  Data: T[];
}

export class VismaClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? VISMA_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(VISMA_RATE_LIMIT, 'ratelimit:visma');
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
          throw new VismaApiError(
            `Visma API error: ${response.status} ${response.statusText}`,
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
    options?: {
      page?: number;
      pageSize?: number;
      modifiedSince?: string;
      modifiedField?: string;
    },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    const pageSize = options?.pageSize ?? 100;
    const page = options?.page ?? 1;

    const params = new URLSearchParams();
    // eAccounting paginates with $page/$pagesize (default 50, max 1000).
    // OData-style $top/$skip are silently IGNORED by the API: every request
    // returns page 1, so a multi-page fetch yields the first page N times
    // and never reaches the rest of the collection.
    params.set('$page', String(page));
    params.set('$pagesize', String(pageSize));

    if (options?.modifiedSince && options?.modifiedField) {
      params.set(
        '$filter',
        `${options.modifiedField} gt ${options.modifiedSince}`,
      );
    }

    const separator = path.includes('?') ? '&' : '?';
    const fullPath = `${path}${separator}${params.toString()}`;

    const response = await this.get<VismaPaginatedResponse<T> & { Meta?: { TotalNumberOfResults?: number; TotalNumberOfPages?: number } }>(accessToken, fullPath);

    const totalPages = response.Meta?.TotalNumberOfPages ?? 1;
    const totalCount = response.Meta?.TotalNumberOfResults ?? 0;

    return {
      items: Array.isArray(response.Data) ? response.Data : [],
      page,
      totalPages,
      totalCount,
    };
  }

  async getPaginated<T>(
    accessToken: string,
    path: string,
    options?: {
      modifiedSince?: string;
      modifiedField?: string;
      pageSize?: number;
    },
  ): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const result = await this.getPage<T>(accessToken, path, {
        page,
        pageSize: options?.pageSize,
        modifiedSince: options?.modifiedSince,
        modifiedField: options?.modifiedField,
      });

      // An empty page means the collection is exhausted regardless of what
      // Meta claims; trusting a stale/buggy TotalNumberOfPages here would
      // re-append duplicate rows or loop for nothing.
      if (result.items.length === 0) break;

      allItems.push(...result.items);
      totalPages = result.totalPages;
      page++;
    } while (page <= totalPages);

    return allItems;
  }
}
