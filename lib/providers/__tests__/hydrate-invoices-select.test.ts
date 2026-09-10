import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSalesInvoicesHydrated, fetchSupplierInvoicesHydrated } from '../provider-data-fetcher';

/**
 * #2469: the migration declines invoices before the detail pass (paid ones
 * outside the imported fiscal years). A declined invoice must cost no
 * detail request and must come back named, so the caller can count it.
 */

function listResponse(key: string, items: Record<string, unknown>[]) {
  return {
    [key]: items,
    MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1, '@TotalResources': items.length },
  };
}

const OLD_PAID = { DocumentNumber: 4, InvoiceDate: '2024-11-01', Currency: 'SEK', Total: 1250, Balance: 0, FullyPaid: true };
const OPEN = { DocumentNumber: 5, InvoiceDate: '2026-02-02', Currency: 'SEK', Total: 500, Balance: 500 };

function detailFor(documentNumber: number, total: number) {
  return {
    Invoice: {
      DocumentNumber: documentNumber,
      InvoiceDate: '2026-02-02',
      Currency: 'SEK',
      Total: total,
      Balance: total,
      Net: total * 0.8,
      TotalVAT: total * 0.2,
      InvoiceRows: [{ RowId: 1, Total: total * 0.8, VAT: 25 }],
    },
  };
}

describe('fetch*InvoicesHydrated with a select predicate (fortnox)', () => {
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

  it('never requests the detail of a declined sales invoice and returns it as excluded', async () => {
    stubFetch((url) => {
      if (url.includes('/invoices/5')) return json(detailFor(5, 500));
      if (url.includes('/invoices/4')) return json(detailFor(4, 1250));
      return json(listResponse('Invoices', [OLD_PAID, OPEN]));
    });

    const { invoices, excluded, hydration } = await fetchSalesInvoicesHydrated(
      'fortnox', 'token', undefined, undefined,
      (dto) => !dto.paymentStatus.paid,
    );

    expect(invoices.map((i) => i.id)).toEqual(['5']);
    expect(excluded?.map((i) => i.id)).toEqual(['4']);
    expect(hydration).toMatchObject({ needed: 1, hydrated: 1 });
    expect(requested.filter((u) => u.includes('/invoices/4'))).toHaveLength(0);
  });

  it('reports no exclusions when no predicate is given', async () => {
    stubFetch((url) => {
      if (/\/invoices\/\d/.test(url)) return json(detailFor(4, 1250));
      return json(listResponse('Invoices', [OLD_PAID, OPEN]));
    });

    const { invoices, excluded } = await fetchSalesInvoicesHydrated('fortnox', 'token');

    expect(invoices).toHaveLength(2);
    expect(excluded).toEqual([]);
  });

  it('applies the predicate to supplier invoices the same way', async () => {
    stubFetch((url) => {
      if (/\/supplierinvoices\/\d/.test(url)) {
        return json({ SupplierInvoice: { GivenNumber: 7, InvoiceDate: '2026-02-02', Currency: 'SEK', Total: 500, Balance: 500, SupplierInvoiceRows: [] } });
      }
      return json(listResponse('SupplierInvoices', [
        { GivenNumber: 6, InvoiceDate: '2024-11-01', Currency: 'SEK', Total: 1250, Balance: 0 },
        { GivenNumber: 7, InvoiceDate: '2026-02-02', Currency: 'SEK', Total: 500, Balance: 500 },
      ]));
    });

    const { invoices, excluded } = await fetchSupplierInvoicesHydrated(
      'fortnox', 'token', undefined, undefined,
      (dto) => !dto.paymentStatus.paid,
    );

    expect(invoices.map((i) => i.id)).toEqual(['7']);
    expect(excluded?.map((i) => i.id)).toEqual(['6']);
    expect(requested.filter((u) => u.includes('/supplierinvoices/6'))).toHaveLength(0);
  });
});
