import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WintClient, WintApiError } from '../client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listResponse(items: unknown[], page: number, totalItems: number, numPerPage = 200): Response {
  return jsonResponse({ Items: items, Page: page, NumPerPage: numPerPage, TotalItems: totalItems });
}

describe('WintClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('auth header', () => {
    it('sends the JWT as a Bearer token', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      const client = new WintClient();
      await client.get('jwt-abc', '/api/Auth');

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer jwt-abc',
      });
    });
  });

  describe('pagination', () => {
    it('getPaginated walks pages until TotalItems is reached', async () => {
      fetchSpy
        .mockResolvedValueOnce(listResponse([{ Id: 1 }, { Id: 2 }], 1, 3, 2))
        .mockResolvedValueOnce(listResponse([{ Id: 3 }], 2, 3, 2));

      const client = new WintClient();
      const items = await client.getPaginated<{ Id: number }>('t', '/api/Customer', { pageSize: 2 });

      expect(items.map((i) => i.Id)).toEqual([1, 2, 3]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(String(fetchSpy.mock.calls[0][0])).toContain('Page=1');
      expect(String(fetchSpy.mock.calls[0][0])).toContain('NumPerPage=2');
      expect(String(fetchSpy.mock.calls[1][0])).toContain('Page=2');
    });

    it('appends pagination params with & when the path already has a query', async () => {
      fetchSpy.mockResolvedValueOnce(listResponse([], 1, 0));

      const client = new WintClient();
      await client.getPage('t', '/api/Voucher?IncludeTransactions=true', { page: 1 });

      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain('/api/Voucher?IncludeTransactions=true&Page=1');
    });

    it('stops after a short page even when TotalItems overcounts', async () => {
      fetchSpy.mockResolvedValueOnce(listResponse([{ Id: 1 }], 1, 99, 200));

      const client = new WintClient();
      const items = await client.getPaginated<{ Id: number }>('t', '/api/Customer');

      expect(items).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('throws when the server ignores the Page param (page-echo guard)', async () => {
      // Both requests answer Page=1 with a FULL page: without the guard this
      // would loop forever appending the same 200 items. Fresh Response per
      // call: a Response body can only be consumed once.
      fetchSpy.mockImplementation(async () =>
        listResponse(Array.from({ length: 200 }, (_, i) => ({ Id: i })), 1, 400, 200),
      );

      const client = new WintClient();
      const err = await client.getPaginated('t', '/api/Transaction').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintApiError);
      expect((err as WintApiError).message).toContain('did not honor Page=2');
    });
  });

  describe('errors', () => {
    it('does NOT retry on 401 and carries the status code', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      const client = new WintClient();
      const err = await client.get('t', '/api/Auth').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintApiError);
      expect((err as WintApiError).statusCode).toBe(401);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
