import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrioxClient, BrioxApiError } from '../client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BrioxClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTimeoutSpy?.mockRestore();
    setTimeoutSpy = null;
  });

  /** Short-circuit withRetry backoff delays so retry tests run instantly. */
  function interceptRetryDelays() {
    const realSetTimeout = globalThis.setTimeout;
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms && ms >= 500 && ms < 120_000) {
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
  }

  describe('auth header', () => {
    it('sends the RAW access token in Authorization: no Bearer prefix', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: {} }));

      const client = new BrioxClient();
      await client.get('raw-token-123', '/account');

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'raw-token-123',
      });
    });
  });

  describe('pagination', () => {
    it('getPaginated loops all pages via data.metainformation', async () => {
      const page = (n: number, totalPages: number, items: unknown[]) =>
        jsonResponse({
          data: {
            invoices: items,
            metainformation: { total_pages: totalPages, current_page: n, total_count: 3 },
          },
        });

      fetchSpy
        .mockResolvedValueOnce(page(1, 2, [{ id: 1 }, { id: 2 }]))
        .mockResolvedValueOnce(page(2, 2, [{ id: 3 }]));

      const client = new BrioxClient();
      const items = await client.getPaginated<{ id: number }>('t', '/customerinvoice', 'invoices');

      expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/customerinvoice?page=1');
      expect(String(fetchSpy.mock.calls[1][0])).toContain('/customerinvoice?page=2');
    });

    it('getPage forwards limit and frommodifieddate params', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: { customers: [], metainformation: { total_pages: 1, current_page: 1, total_count: 0 } },
        }),
      );

      const client = new BrioxClient();
      await client.getPage('t', '/customer', 'customers', {
        page: 2,
        pageSize: 50,
        fromModifiedDate: '2026-01-01',
      });

      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain('page=2');
      expect(url).toContain('limit=50');
      expect(url).toContain('frommodifieddate=2026-01-01');
    });

    it('getPage tolerates a missing metainformation block', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { customers: [{ id: 1 }] } }));

      const client = new BrioxClient();
      const result = await client.getPage<{ id: number }>('t', '/customer', 'customers');

      expect(result.items).toHaveLength(1);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('retry', () => {
    it('retries on 500 and succeeds', async () => {
      interceptRetryDelays();
      fetchSpy
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const client = new BrioxClient();
      const result = await client.get<{ data: { ok: boolean } }>('t', '/account');

      expect(result.data.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries on 429 and succeeds', async () => {
      interceptRetryDelays();
      fetchSpy
        .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const client = new BrioxClient();
      const result = await client.get<{ data: { ok: boolean } }>('t', '/account');

      expect(result.data.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 401', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      const client = new BrioxClient();
      const err = await client.get('t', '/account').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BrioxApiError);
      expect((err as BrioxApiError).statusCode).toBe(401);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 404', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      const client = new BrioxClient();
      const err = await client.get('t', '/account').catch((e: unknown) => e);

      expect((err as BrioxApiError).statusCode).toBe(404);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBytes (SIE octet-stream)', () => {
    it('returns the raw bytes and authenticates with the raw token', async () => {
      const bytes = new Uint8Array([0x23, 0x46, 0x4c, 0x41, 0x47, 0x47, 0x41]); // "#FLAGGA"
      fetchSpy.mockResolvedValueOnce(
        new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      );

      const client = new BrioxClient();
      const buffer = await client.getBytes('raw-token-123', '/sie/10/4');

      expect(new Uint8Array(buffer)).toEqual(bytes);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/sie/10/4');
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'raw-token-123' });
    });

    it('throws BrioxApiError with status on failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 404 }));

      const client = new BrioxClient();
      const err = await client.getBytes('t', '/sie/99/4').catch((e: unknown) => e);

      expect((err as BrioxApiError).statusCode).toBe(404);
    });
  });

  describe('financial years', () => {
    it('listFinancialYears unwraps data.financialyears', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: {
            financialyears: [
              { id: '9', fromdate: '2024-01-01', todate: '2024-12-31' },
              { id: '10', fromdate: '2025-01-01', todate: '2025-12-31' },
            ],
          },
        }),
      );

      const client = new BrioxClient();
      const years = await client.listFinancialYears('t');

      expect(years).toHaveLength(2);
      expect(years[1]).toEqual({ id: '10', fromdate: '2025-01-01', todate: '2025-12-31' });
    });

    it('getCurrentFinancialYear picks the last completed year', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: {
            financialyears: [
              { id: '9', fromdate: '2024-01-01', todate: '2024-12-31' },
              { id: '10', fromdate: '2025-01-01', todate: '2025-12-31' },
              { id: '11', fromdate: '2099-01-01', todate: '2099-12-31' },
            ],
          },
        }),
      );

      const client = new BrioxClient();
      await expect(client.getCurrentFinancialYear('t')).resolves.toBe('10');
    });
  });
});
