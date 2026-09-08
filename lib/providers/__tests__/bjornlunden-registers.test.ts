import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCustomersDirect,
  fetchSalesInvoicesDirect,
  fetchSuppliersDirect,
} from '../provider-data-fetcher';

/**
 * Björn Lundén answers its two register endpoints (/customer, /supplier) as
 * one bare array and ignores paging, while the batch endpoints page under
 * `page` + `rows`. The fetchers used to page the registers too, and the
 * client read the bare array as an envelope with no `data`: every BL
 * migration imported zero customers and zero suppliers, and rebuilt both as
 * stubs from the invoices. Verified against production BL on 2026-09-08 for
 * a company with 376 customers and 9 415 customer invoices.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('Björn Lundén registers and batches', () => {
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

  it('reads the whole customer register from the one bare-array answer, without paging params', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return json([
        { id: 1001, name: 'Kund Ett AB', organisationNumber: '5566778899', closed: false },
        { id: 1002, name: 'Kund Två AB', closed: false },
        { id: 1003, name: 'Nedlagd AB', closed: true },
      ]);
    }));

    const customers = await fetchCustomersDirect('bjornlunden', 'token', 'user-key');

    expect(requested).toHaveLength(1);
    const url = new URL(requested[0]);
    expect(url.pathname.endsWith('/customer')).toBe(true);
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('rows')).toBe(false);
    expect(customers.map((c) => c.id)).toEqual(['1001', '1002', '1003']);
    expect(customers.map((c) => c.active)).toEqual([true, true, false]);
    expect(customers[0].party.identifications).toEqual([{ id: '5566778899', schemeId: 'SE:ORGNR' }]);
  });

  it('reads the whole supplier register the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return json([
        { id: 2001, name: 'Leverantör AB', organisationNumber: '5511223344', closed: false },
      ]);
    }));

    const suppliers = await fetchSuppliersDirect('bjornlunden', 'token', 'user-key');

    expect(requested).toHaveLength(1);
    expect(new URL(requested[0]).pathname.endsWith('/supplier')).toBe(true);
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].party.name).toBe('Leverantör AB');
  });

  it('walks the customer-invoice batch in 1 000-row pages until totalPages', async () => {
    const invoice = (n: number) => ({
      entityId: 90000 + n, invoiceNumber: n, invoiceDate: '2025-11-01', currency: 'SEK', amountInLocalCurrency: 100 * n, paid: false,
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return json({
        pageRequested: page,
        totalPages: 2,
        totalRows: 3,
        data: page === 1 ? [invoice(1), invoice(2)] : [invoice(3)],
      });
    }));

    const invoices = await fetchSalesInvoicesDirect('bjornlunden', 'token', 'user-key');

    expect(requested).toHaveLength(2);
    for (const [index, url] of requested.entries()) {
      const params = new URL(url).searchParams;
      expect(params.get('rows')).toBe('1000');
      expect(params.get('page')).toBe(String(index + 1));
    }
    expect(invoices.map((dto) => dto.invoiceNumber)).toEqual(['1', '2', '3']);
  });
});
