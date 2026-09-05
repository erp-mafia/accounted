import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSalesInvoicesDirect, fetchSalesInvoicesHydrated, hydrateSalesInvoices } from '../provider-data-fetcher';

/**
 * Hydration is what makes the VAT fix work in production: the list payload
 * Fortnox returns has no `Net`, no `TotalVAT` and no `InvoiceRows`, so without
 * a second call there is nothing to map. These tests pin the three properties
 * that keep it safe at the observed volumes (up to 1 911 invoices per company
 * against a 4 req/s limit and a 300 s function ceiling): only fetch what is
 * missing, serve open invoices first, and report whatever the budget missed.
 */

function listResponse(invoices: Record<string, unknown>[]) {
  return {
    Invoices: invoices,
    MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1, '@TotalResources': invoices.length },
  };
}

const OPEN = { DocumentNumber: 4, InvoiceDate: '2025-11-01', Currency: 'SEK', Total: 1250, Balance: 1250 };
const PAID = { DocumentNumber: 5, InvoiceDate: '2025-11-02', Currency: 'SEK', Total: 500, Balance: 0, FullyPaid: true };

function detailFor(documentNumber: number, total: number) {
  return {
    Invoice: {
      DocumentNumber: documentNumber,
      InvoiceDate: '2025-11-01',
      Currency: 'SEK',
      Total: total,
      Balance: total,
      Net: total * 0.8,
      TotalVAT: total * 0.2,
      InvoiceRows: [{ RowId: 1, Total: total * 0.8, VAT: 25 }],
    },
  };
}

describe('fetchSalesInvoicesHydrated (fortnox)', () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubFetch(handler: (url: string) => Response) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return handler(url);
    }));
  }

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('fills in the VAT the list payload omitted', async () => {
    stubFetch((url) => url.includes('/invoices/4') ? json(detailFor(4, 1250)) : json(listResponse([OPEN])));

    const { invoices, hydration, unhydratedIds } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(hydration).toMatchObject({ needed: 1, hydrated: 1, failed: 0, skippedForBudget: 0 });
    expect(unhydratedIds.size).toBe(0);
    expect(invoices[0]?.taxTotal?.taxAmount.value).toBe(250);
    expect(invoices[0]?.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000);
    expect(invoices[0]?.lines).toHaveLength(1);
  });

  it('does not spend a request on an invoice that is already complete', async () => {
    // A list payload that already carries Net, TotalVAT and rows has nothing
    // to gain from its detail form.
    const complete = { ...OPEN, Net: 1000, TotalVAT: 250, InvoiceRows: [{ RowId: 1, Total: 1000, VAT: 25 }] };
    stubFetch(() => json(listResponse([complete])));

    const { hydration } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(hydration).toMatchObject({ needed: 0, hydrated: 0 });
    expect(requested.filter((u) => u.includes('/invoices/4'))).toHaveLength(0);
  });

  it('requests the OPEN invoice before the paid one', async () => {
    // Open invoices are the ones a later payment match or credit note books,
    // so they must not be the ones a tight budget drops.
    stubFetch((url) => {
      if (url.includes('/invoices/5')) return json(detailFor(5, 500));
      if (url.includes('/invoices/4')) return json(detailFor(4, 1250));
      return json(listResponse([PAID, OPEN]));
    });

    await fetchSalesInvoicesHydrated('fortnox', 'token');

    const details = requested.filter((u) => /\/invoices\/\d/.test(u));
    expect(details[0]).toContain('/invoices/4');
  });

  it('reports what the budget could not reach instead of looking complete', async () => {
    stubFetch(() => json(listResponse([OPEN, PAID])));

    const { invoices, hydration, unhydratedIds } = await fetchSalesInvoicesHydrated('fortnox', 'token', undefined, 0);

    expect(hydration).toMatchObject({ needed: 2, hydrated: 0, skippedForBudget: 2 });
    // The invoices themselves are still returned, unhydrated, and named as
    // such: a detail-only field (Fortnox's voucher ref) is unknown for these.
    expect(invoices).toHaveLength(2);
    expect([...unhydratedIds].sort()).toEqual(['4', '5']);
    expect(requested.filter((u) => /\/invoices\/\d/.test(u))).toHaveLength(0);
  });

  it('stops the whole pass when the provider rejects the token', async () => {
    // 401/403 fails identically for every remaining invoice. Issuing hundreds
    // more doomed calls would spend the Fortnox rate-limit budget (shared
    // platform-wide) for nothing.
    // More invoices than HYDRATION_CONCURRENCY, so the abort has something
    // left to prevent: the first few are already in flight when the first 401
    // lands, and everything after that must never be requested.
    const many = Array.from({ length: 20 }, (_, i) => ({ ...OPEN, DocumentNumber: 100 + i }));
    stubFetch((url) => url.includes('/invoices/1')
      ? new Response('unauthorized', { status: 401 })
      : json(listResponse(many)));

    const { invoices, hydration } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(hydration.abortedBy).toBe('auth');
    expect(hydration.hydrated).toBe(0);
    // Every invoice is still returned, unhydrated.
    expect(invoices).toHaveLength(20);
    // Only the concurrency window was spent, not all 20.
    const details = requested.filter((u) => /\/invoices\/\d\d\d/.test(u));
    expect(details.length).toBeGreaterThan(0);
    expect(details.length).toBeLessThanOrEqual(3);
  });

  it('does not stop the pass on a 404 for one invoice', async () => {
    // A missing invoice is about that invoice, not the credential.
    stubFetch((url) => {
      if (url.includes('/invoices/4')) return new Response('gone', { status: 404 });
      if (url.includes('/invoices/5')) return json(detailFor(5, 500));
      return json(listResponse([OPEN, PAID]));
    });

    const { hydration } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(hydration.abortedBy).toBeUndefined();
    expect(hydration.failed).toBe(1);
    expect(hydration.hydrated).toBe(1);
  });

  it('keeps the list-form invoice when its detail fetch fails', async () => {
    stubFetch((url) => url.includes('/invoices/4')
      ? new Response('boom', { status: 404 })
      : json(listResponse([OPEN])));

    const { invoices, hydration, unhydratedIds } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(hydration).toMatchObject({ needed: 1, hydrated: 0, failed: 1 });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.legalMonetaryTotal.payableAmount.value).toBe(1250);
    expect(unhydratedIds.has('4')).toBe(true);
  });
});

describe('fetchSalesInvoicesHydrated: detail id comes from the configured idField', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses BL invoiceNumber, not the entityId its DTO id is built from', async () => {
    // Björn Lundén's sales config names `invoiceNumber` as idField, while its
    // mapper sets dto.id from `entityId`. Addressing the detail endpoint by
    // dto.id would request invoice 99001 instead of 5. The two differ here on
    // purpose: with equal values the test would pass either way.
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes('/customerinvoice/batch')) {
        return new Response(JSON.stringify({
          data: [{ entityId: 99001, invoiceNumber: 5, invoiceDate: '2025-11-01', currency: 'SEK', amountInLocalCurrency: 1250, paid: false }],
          totalPages: 1,
          pageRequested: 1,
          totalRows: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        entityId: 99001, invoiceNumber: 5, invoiceDate: '2025-11-01',
        currency: 'SEK', amountInLocalCurrency: 1250, vatAmount: 250, paid: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const { invoices } = await fetchSalesInvoicesHydrated('bjornlunden', 'token', 'user-key');

    const detail = seen.find((u) => u.includes('/customerinvoice/') && !u.includes('/batch'));
    expect(detail).toContain('/customerinvoice/5');
    expect(detail).not.toContain('99001');
    // And the hydrated payload's VAT actually landed.
    expect(invoices[0]?.taxTotal?.taxAmount.value).toBe(250);
  });
});

describe('hydrateSalesInvoices: a caller-chosen subset of an already-listed register', () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('requests the detail form only for the invoices it was given', async () => {
    // A follow-up pass knows which invoices are still incomplete on its own
    // side. Re-hydrating the whole register would spend every run on the
    // same open invoices first and never reach the rest.
    const third = { ...PAID, DocumentNumber: 6, InvoiceDate: '2025-11-03' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      if (url.includes('/invoices/5')) return json(detailFor(5, 500));
      if (url.includes('/invoices/6')) return json(detailFor(6, 500));
      return json(listResponse([OPEN, PAID, third]));
    }));

    const listed = await fetchSalesInvoicesDirect('fortnox', 'token');
    const subset = listed.filter((dto) => dto.id !== '4');

    const { invoices, hydration, unhydratedIds } = await hydrateSalesInvoices('fortnox', 'token', undefined, subset);

    expect(hydration).toMatchObject({ needed: 2, hydrated: 2, failed: 0, skippedForBudget: 0 });
    expect(unhydratedIds.size).toBe(0);
    // Same order as given, so the caller can pair results back by index.
    expect(invoices.map((dto) => dto.id)).toEqual(['5', '6']);
    expect(invoices.every((dto) => dto.lines.length === 1)).toBe(true);
    const details = requested.filter((u) => /\/invoices\/\d/.test(u));
    expect(details).toHaveLength(2);
    expect(details.some((u) => u.includes('/invoices/4'))).toBe(false);
  });

  it('reports the subset it could not reach, in the caller\'s ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return json(listResponse([OPEN, PAID]));
    }));

    const listed = await fetchSalesInvoicesDirect('fortnox', 'token');

    const { invoices, hydration, unhydratedIds } = await hydrateSalesInvoices('fortnox', 'token', undefined, listed, 0);

    expect(hydration).toMatchObject({ needed: 2, hydrated: 0, skippedForBudget: 2 });
    expect([...unhydratedIds].sort()).toEqual(['4', '5']);
    expect(invoices).toHaveLength(2);
  });
});
