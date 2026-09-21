import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../rate-limiter', () => ({ TokenBucketRateLimiter: class { async acquire() {} } }));
import { fetchMigrationPage, fetchSalesInvoicesHydrated, fetchSupplierInvoicesHydrated, hydrateSalesInvoices, hydrateSupplierInvoices } from '../provider-data-fetcher';
import { mapBokioToSalesInvoice } from '../bokio/mapper';
import type { SupplierInvoiceDto } from '../dto';

const COMPANY = 'source-company';
const BASE = `/v1/companies/${COMPANY}`;
const INVOICE = {
  id: 'invoice-1', invoiceNumber: '1001', status: 'published',
  invoiceDate: '2025-06-01', currency: 'SEK', totalAmount: 1250, totalTax: 250,
  remainingAmount: 1250, journalEntryRef: { id: 'journal-1' },
  lineItems: [{ description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 25 }],
};
const JOURNAL = { id: 'journal-1', journalEntryNumber: 'V342', date: '2025-06-01' };

function stubBokio(journal: () => Response | Promise<Response> = () => Response.json(JOURNAL)) {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    requested.push(url.pathname);
    if (url.pathname === `${BASE}/journal-entries/journal-1`) return journal();
    if (url.pathname === `${BASE}/credit-notes`) return Response.json({ items: [], totalPages: 1 });
    if (url.pathname.endsWith('/invoice-1')) return Response.json(INVOICE);
    return Response.json({ items: [INVOICE], currentPage: 1, totalPages: 1, totalItems: 1 });
  }));
  return requested;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Bokio invoice voucher hydration', () => {
  it.each([
    ['sales', fetchSalesInvoicesHydrated],
    ['supplier', fetchSupplierInvoicesHydrated],
  ] as const)('resolves the %s invoice UUID to a source voucher without re-fetching complete invoice details', async (_, fetchInvoices) => {
    const requested = stubBokio();
    const { invoices, unhydratedIds } = await fetchInvoices('bokio', 'token', COMPANY);

    expect(invoices[0].sourceVoucher).toEqual({ series: 'V', number: 342 });
    expect(invoices[0]._raw).toEqual(INVOICE);
    expect(unhydratedIds.size).toBe(0);
    expect(requested.filter(path => path.includes('/journal-entries'))).toEqual([`${BASE}/journal-entries/journal-1`]);
    expect(requested.some(path => path.endsWith('/invoice-1'))).toBe(false);
  });

  it('resolves a persisted worker page after supplier detail hydration without dropping the reference', async () => {
    const requested = stubBokio();
    const page = await fetchMigrationPage('bokio', 'token', COMPANY, 'supplierInvoices', 1);
    const listed = page.items[0] as SupplierInvoiceDto;
    listed.taxTotal = undefined;
    const { invoices } = await hydrateSupplierInvoices('bokio', 'token', COMPANY, [listed]);

    expect(requested).toContain(`${BASE}/supplier-invoices/invoice-1`);
    expect(invoices[0].sourceVoucher).toEqual({ series: 'V', number: 342 });
  });

  it('also resolves credit notes and preserves their original-invoice reference', async () => {
    stubBokio();
    const credit = mapBokioToSalesInvoice({ ...INVOICE, creditDate: '2025-06-01', invoiceRef: { id: 'original-1' } });
    const { invoices } = await hydrateSalesInvoices('bokio', 'token', COMPANY, [credit]);

    expect(invoices[0]).toMatchObject({ invoiceTypeCode: '381', creditedInvoiceRef: { id: 'original-1' }, sourceVoucher: { series: 'V', number: 342 } });
  });

  it('does not request a journal for an invoice with no journalEntryRef', async () => {
    const requested = stubBokio();
    const invoice = mapBokioToSalesInvoice({ ...INVOICE, journalEntryRef: null });
    const { invoices, hydration } = await hydrateSalesInvoices('bokio', 'token', COMPANY, [invoice]);

    expect(requested).toEqual([]);
    expect(invoices[0].sourceVoucher).toBeUndefined();
    expect(hydration.needed).toBe(0);
  });

  it('retains recovered invoice lines when the journal scope is unavailable', async () => {
    stubBokio(() => new Response('', { status: 403 }));
    const listed = mapBokioToSalesInvoice({ ...INVOICE, lineItems: [] });
    const result = await hydrateSalesInvoices('bokio', 'token', COMPANY, [listed]);
    expect(result.invoices[0].lines).toHaveLength(1);
    expect(result.invoices[0].sourceVoucher).toBeUndefined();
    expect(result.unhydratedIds.has(listed.id)).toBe(true);
  });

  it.each([401, 403, 404])('reports a journal lookup HTTP %s failure instead of claiming there was no voucher', async status => {
    stubBokio(() => new Response('', { status }));
    const listed = mapBokioToSalesInvoice(INVOICE);
    const result = await hydrateSalesInvoices('bokio', 'token', COMPANY, [listed]);

    expect(result.invoices).toEqual([listed]);
    expect(result.unhydratedIds.has(listed.id)).toBe(true);
    expect(result.hydration.failed).toBe(1);
    expect(result.hydration.abortedBy).toBe(status === 404 ? undefined : 'auth');
  });

  it.each([
    { ...JOURNAL, id: 'another-journal' },
    { ...JOURNAL, journalEntryNumber: 'unreadable' },
  ])('does not attach an uncorroborated journal response', async journal => {
    stubBokio(() => Response.json(journal));
    const result = await hydrateSalesInvoices('bokio', 'token', COMPANY, [mapBokioToSalesInvoice(INVOICE)]);
    expect(result.invoices[0].sourceVoucher).toBeUndefined();
    expect(result.unhydratedIds.has(INVOICE.id)).toBe(true);
  });

  it('keeps journal resolution inside the hydration deadline', async () => {
    vi.useFakeTimers();
    stubBokio(() => new Promise<Response>(() => {}));
    const pending = hydrateSalesInvoices('bokio', 'token', COMPANY, [mapBokioToSalesInvoice(INVOICE)], 50);
    await vi.advanceTimersByTimeAsync(51);
    const result = await pending;
    expect(result.hydration.abortedBy).toBe('budget');
    expect(result.unhydratedIds.has(INVOICE.id)).toBe(true);
  });
});
