import { TokenBucketRateLimiter } from '../rate-limiter';
import { withRetry } from '../retry';
import { BOKIO_BASE_URL, BOKIO_RATE_LIMIT } from './config';
import { createLogger } from '@/lib/logger';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';

const log = createLogger('bokio-client');

const FETCH_TIMEOUT_MS = 15_000;

export class BokioApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'BokioApiError';
  }
}

export class BokioResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BokioResponseError';
  }
}

/**
 * Accept either the integration token itself or a copied Authorization value.
 * Only surrounding whitespace and one explicit Bearer scheme are removed:
 * internal token characters are left untouched.
 */
export function normalizeBokioAccessToken(accessToken: string): string {
  return accessToken.trim().replace(/^Bearer\s+/i, '').trim();
}

function bokioAuthorizationHeader(accessToken: string): string {
  return `Bearer ${normalizeBokioAccessToken(accessToken)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeBokioCompany(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    (typeof value['id'] === 'string' ||
      typeof value['name'] === 'string' ||
      typeof value['organizationNumber'] === 'string')
  );
}

/**
 * Extract the company object from a company-information response body.
 * If the documented `companyInformation` envelope key is present, the company
 * must be inside it (a malformed envelope is rejected, never bypassed via
 * outer fields); otherwise the flat object the live API returns is accepted.
 * Either way the object must carry an identifying field, so `{}` or an
 * unrelated JSON object is rejected. Returns null when no company is found.
 */
export function unwrapBokioCompanyInformation(
  body: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;

  if ('companyInformation' in body) {
    const wrapped = body['companyInformation'];
    return looksLikeBokioCompany(wrapped) ? wrapped : null;
  }

  return looksLikeBokioCompany(body) ? body : null;
}

function isRetryableError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof BokioApiError) {
    if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return false;
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

interface BokioPaginatedResponse<T> {
  items?: T[];
  data?: T[];    // Some Bokio endpoints use 'data' instead of 'items'
  totalItems: number;
  totalPages: number;
  currentPage: number;
}

export class BokioClient {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BOKIO_BASE_URL;
    this.rateLimiter = new TokenBucketRateLimiter(BOKIO_RATE_LIMIT, 'ratelimit:bokio');
  }

  async get<T>(accessToken: string, path: string): Promise<T> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          headers: {
            Authorization: bokioAuthorizationHeader(accessToken),
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BokioApiError(
            `Bokio API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return await response.json() as T;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  /**
   * Fetch a paginated list endpoint.
   * Bokio returns `{ items: [...], totalItems, totalPages, currentPage }`.
   * Some endpoints may use `data` instead of `items`.
   */
  async getPage<T>(
    accessToken: string,
    companyId: string,
    relativePath: string,
    options?: {
      page?: number;
      pageSize?: number;
      query?: string;
    },
  ): Promise<{ items: T[]; page: number; totalPages: number; totalCount: number }> {
    const params = new URLSearchParams();
    params.set('page', String(options?.page ?? 1));
    params.set('pageSize', String(options?.pageSize ?? 50));
    if (options?.query) {
      params.set('query', options.query);
    }

    const path = `/companies/${companyId}${relativePath}?${params.toString()}`;
    const response = await this.get<BokioPaginatedResponse<T>>(accessToken, path);

    // Bokio uses 'items' for most endpoints but 'data' for some (e.g., credit notes)
    const items = Array.isArray(response.items)
      ? response.items
      : Array.isArray(response.data)
        ? response.data
        : [];

    const result = {
      items,
      page: response.currentPage ?? (options?.page ?? 1),
      totalPages: response.totalPages ?? 1,
      totalCount: response.totalItems ?? 0,
    };

    log.info(
      `getPage ${relativePath} page=${result.page}/${result.totalPages}: ` +
      `${result.items.length} items (totalCount=${result.totalCount})` +
      (result.items.length === 0 && result.totalCount > 0
        ? `; WARNING: 0 items despite totalCount=${result.totalCount}, raw keys: ${Object.keys(response).join(', ')}`
        : ''),
    );

    // Extra diagnostic: if no items found and response has unexpected keys, log them
    if (result.items.length === 0) {
      const rawObj = response as unknown as Record<string, unknown>;
      const keys = Object.keys(rawObj).filter(k => !['totalItems', 'totalPages', 'currentPage', 'items', 'data'].includes(k));
      if (keys.length > 0) {
        log.warn(
          `Unexpected response keys for ${relativePath}: ${keys.join(', ')}. ` +
          `Values: ${keys.map(k => `${k}=${typeof rawObj[k] === 'object' ? JSON.stringify(rawObj[k]).slice(0, 200) : rawObj[k]}`).join(', ')}`,
        );
      }
    }

    return result;
  }

  /**
   * Fetch a non-paginated list endpoint (e.g. chart-of-accounts).
   * Returns the full `data` array.
   */
  async getAll<T>(
    accessToken: string,
    companyId: string,
    relativePath: string,
  ): Promise<T[]> {
    const path = `/companies/${companyId}${relativePath}`;
    const response = await this.get<T[] | { items: T[] }>(accessToken, path);
    // Bokio returns a raw array for some endpoints (e.g. chart-of-accounts)
    if (Array.isArray(response)) {
      return response;
    }
    return Array.isArray(response.items) ? response.items : [];
  }

  /**
   * Fetch a single resource detail.
   * Bokio returns the object directly (no wrapper).
   */
  async getDetail<T>(
    accessToken: string,
    companyId: string,
    relativePath: string,
  ): Promise<T> {
    const path = `/companies/${companyId}${relativePath}`;
    return this.get<T>(accessToken, path);
  }

  /**
   * Download a binary resource (e.g. an uploaded receipt) as raw bytes.
   * Bokio serves `/uploads/{id}/download` as application/octet-stream, so the
   * declared content type must come from the upload's own `contentType`, not
   * the response header. Same rate-limit + retry envelope as get().
   */
  async getBytes(
    accessToken: string,
    companyId: string,
    relativePath: string,
  ): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const url = `${this.baseUrl}/companies/${companyId}${relativePath}`;
        const response = await fetch(url, {
          headers: { Authorization: bokioAuthorizationHeader(accessToken) },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new BokioApiError(
            `Bokio API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
          );
        }

        return {
          bytes: await response.arrayBuffer(),
          contentType: response.headers.get('content-type'),
        };
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: isRetryableError,
      },
    );
  }

  /**
   * Probe one company via the documented v1 company-information endpoint.
   *
   * Bokio's published v1 spec wraps the body as `{ companyInformation: {...} }`,
   * but the live api.bokio.se/v1 returns the company object flat
   * (`{ id, name, organizationNumber, companyType, address, ... }`). Both are
   * accepted: a valid token must never be reported as a failure because the
   * spec and the deployed API disagree on the envelope.
   */
  async getCompany<T>(
    accessToken: string,
    companyId: string,
  ): Promise<T | null> {
    try {
      const normalizedCompanyId = companyId.trim();
      const response = await this.get<unknown>(
        accessToken,
        `/companies/${encodeURIComponent(normalizedCompanyId)}/company-information`,
      );

      const company = unwrapBokioCompanyInformation(response);
      if (company == null) {
        throw new BokioResponseError(
          'Bokio company-information response contains no company object',
        );
      }

      return company as T;
    } catch (err) {
      if (err instanceof BokioApiError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }
}
