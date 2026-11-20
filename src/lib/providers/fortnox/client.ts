import { fetchInExecutionBudget } from '@/lib/http/execution-budget';
import { TokenBucketRateLimiter, connectionRateKey } from '../rate-limiter';
import { withRetry } from '../retry';
import { FORTNOX_BASE_URL, FORTNOX_RATE_LIMIT } from './config';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';
import { cleanProviderPayload } from '../provider-text';
import { fortnoxRetryAfter } from './oauth-error';

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
 * Fortnox documents numeric resource error codes separately from OAuth errors.
 * The key is spelled both ways in live answers: `code` on a missing licence
 * (2001101), `Code` on a per-register 403 (2003275), as fortnoxErrorMessage
 * already reads `message` and `Message`. What a code means for a refusal is
 * read in fortnoxRefusal, nowhere else.
 */
export function fortnoxApiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof FortnoxApiError) || !error.body) return undefined;
  try {
    const parsed = JSON.parse(error.body);
    const code = parsed?.ErrorInformation?.code ?? parsed?.ErrorInformation?.Code;
    return typeof code === 'number' || (typeof code === 'string' && /^\d+$/.test(code)) ? String(code) : undefined;
  } catch { return undefined; }
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
 * Why Fortnox refused a call:
 *
 *   api_license  the Fortnox account has no API licence at all (2001103)
 *   license      the Fortnox company lacks the module a scope needs (2001101)
 *   permission   the call may not read this resource (2000663, or a register
 *                the user who connected may not see)
 */
export type FortnoxRefusalReason = 'api_license' | 'license' | 'permission';

export interface FortnoxRefusal {
  reason: FortnoxRefusalReason;
  /**
   * Fortnox named the cause with a code it documents. A bare 403 or a
   * sentence alone is not documented evidence; callers that suspend
   * scheduled work on a refusal (fortnoxCompletionBlock) require it.
   */
  documented: boolean;
}

/** Fortnox developer docs, "Errors". */
const DOCUMENTED_REFUSALS: Readonly<Record<string, FortnoxRefusalReason>> = {
  '2001103': 'api_license', // "Api-licens saknas."
  '2001101': 'license', // "Det finns ingen aktiv licens för önskat scope"
  '2000663': 'permission', // "Har inte behörighet för scope"
};

const REFUSAL_TEXT = /beh[öo]righet|r[äa]ttighet|scope|licens|licence|license|permission|unauthori[sz]ed/i;

/**
 * The one reading of a Fortnox refusal: classifyProviderError,
 * providerRefusalReason and fortnoxCompletionBlock all decide through it, so
 * the migration job, the SIE preview, the underlag import, asset import and
 * invoice completion cannot disagree about the same answer. Null when the
 * error is not a refusal (a dead token answers 401, an outage 5xx).
 *
 * An ordinary Fortnox connection reads with the rights of the Fortnox user
 * who approved it (only a service account, which we do not request, is
 * detached from a person). A register that user may not see is refused
 * although the integration's scopes cover it, and Fortnox names the register
 * with an undocumented code per register, under either status. Live answers
 * (prod logs 2026-10-05 and 2026-10-12):
 *
 *   403 2003275 "Saknar behörighet för leverantörsregister."
 *   400 2002182 "Saknar behörighet för leverantörsfaktura."
 *   400 2001538 "Saknar behörighet för kundregister."
 *   403 (plain text) "Du saknar behörighet för GET-anrop mot /3/invoices"
 *
 * and elsewhere "Saknar rättighet för att använda verifikationer." (2001381).
 * Those are read from the status (Fortnox answers 401 for a dead token, so a
 * 403 is a refusal) or from the sentence on a 400.
 */
export function fortnoxRefusal(error: unknown): FortnoxRefusal | null {
  if (!(error instanceof FortnoxApiError) || error.statusCode >= 500 || error.statusCode === 429) return null;
  const code = fortnoxApiErrorCode(error);
  const documented = code ? DOCUMENTED_REFUSALS[code] : undefined;
  if (documented) return { reason: documented, documented: true };
  if (error.statusCode !== 403 && error.statusCode !== 400) return null;
  const text = `${error.body ?? ''} ${fortnoxErrorMessage(error) ?? ''}`;
  if (error.statusCode === 400 && !REFUSAL_TEXT.test(text)) return null;
  const reason: FortnoxRefusalReason = /api-licens/i.test(text)
    ? 'api_license'
    : /licens|licence|license/i.test(text)
      ? 'license'
      : 'permission';
  return { reason, documented: false };
}

/** Any refusal, see fortnoxRefusal. */
export function isFortnoxPermissionError(error: unknown): error is FortnoxApiError {
  return fortnoxRefusal(error) !== null;
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
        await this.rateLimiter.acquire(connectionRateKey(accessToken));
        const url = `${this.baseUrl}${path}`;
        const response = await fetchInExecutionBudget(url, {
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
            const seconds = fortnoxRetryAfter(retryAfter);
            retryAfterMs = seconds === undefined ? undefined : seconds * 1000;
          }
          throw new FortnoxApiError(
            `Fortnox API error: ${response.status} ${response.statusText}`,
            response.status,
            body,
            retryAfterMs,
          );
        }

        return cleanProviderPayload(await response.json()) as T;
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
        await this.rateLimiter.acquire(connectionRateKey(accessToken));
        const url = `${this.baseUrl}${path}`;
        const response = await fetchInExecutionBudget(url, {
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
            const seconds = fortnoxRetryAfter(retryAfter);
            retryAfterMs = seconds === undefined ? undefined : seconds * 1000;
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
        await this.rateLimiter.acquire(connectionRateKey(accessToken));
        const url = `${this.baseUrl}${path}`;
        const response = await fetchInExecutionBudget(url, {
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
            const seconds = fortnoxRetryAfter(retryAfter);
            retryAfterMs = seconds === undefined ? undefined : seconds * 1000;
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
