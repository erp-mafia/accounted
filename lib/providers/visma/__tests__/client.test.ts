import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VismaClient } from '../client';

/**
 * Guards the eAccounting pagination convention: the API paginates with
 * $page/$pagesize and silently IGNORES OData $top/$skip. When the client sent
 * $top/$skip, every request returned page 1, so getPaginated appended the
 * first page TotalNumberOfPages times: N-fold duplicate customers, and
 * whole-chunk unique violations on invoice import (the "300 misslyckades"
 * support case).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(items: unknown[], totalPages: number, totalCount?: number): Response {
  return jsonResponse({
    Meta: {
      TotalNumberOfPages: totalPages,
      TotalNumberOfResults: totalCount ?? items.length,
    },
    Data: items,
  });
}

describe('VismaClient pagination', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function requestedUrl(callIndex: number): URL {
    const [input] = fetchSpy.mock.calls[callIndex];
    return new URL(String(input));
  }

  it('getPage sends $page/$pagesize, never $top/$skip', async () => {
    fetchSpy.mockResolvedValueOnce(page([{ Id: 'a' }], 1));

    const client = new VismaClient();
    await client.getPage('token', '/customers', { page: 2, pageSize: 100 });

    const url = requestedUrl(0);
    expect(url.searchParams.get('$page')).toBe('2');
    expect(url.searchParams.get('$pagesize')).toBe('100');
    expect(url.searchParams.has('$top')).toBe(false);
    expect(url.searchParams.has('$skip')).toBe(false);
  });

  it('getPaginated walks every page once and concatenates in order', async () => {
    fetchSpy
      .mockResolvedValueOnce(page([{ Id: 'a' }, { Id: 'b' }], 3, 5))
      .mockResolvedValueOnce(page([{ Id: 'c' }, { Id: 'd' }], 3, 5))
      .mockResolvedValueOnce(page([{ Id: 'e' }], 3, 5));

    const client = new VismaClient();
    const items = await client.getPaginated<{ Id: string }>('token', '/customerinvoices');

    expect(items.map((i) => i.Id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(requestedUrl(0).searchParams.get('$page')).toBe('1');
    expect(requestedUrl(1).searchParams.get('$page')).toBe('2');
    expect(requestedUrl(2).searchParams.get('$page')).toBe('3');
  });

  it('getPaginated stops on an empty page even if Meta promises more', async () => {
    fetchSpy
      .mockResolvedValueOnce(page([{ Id: 'a' }], 99))
      .mockResolvedValueOnce(page([], 99));

    const client = new VismaClient();
    const items = await client.getPaginated<{ Id: string }>('token', '/customers');

    expect(items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
