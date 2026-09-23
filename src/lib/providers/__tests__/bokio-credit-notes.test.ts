import { afterEach, describe, expect, it, vi } from 'vitest';
// Pagination and routing test: no throttling against a stubbed fetch.
vi.mock('../rate-limiter', () => ({ TokenBucketRateLimiter: class { async acquire() {} } }));
import { fetchMigrationPage, fetchSalesInvoicesDirect, hydrateSalesInvoices } from '../provider-data-fetcher';
import { mapBokioToSalesInvoice } from '../bokio/mapper';
import { BokioApiError } from '../bokio/client';
import type { SalesInvoiceDto } from '../dto';

/**
 * Bokio publishes kreditfakturor on /companies/{id}/credit-notes, a resource
 * of its own beside /invoices (company-api spec, github.com/bokio/bokio-api
 * branch v1; docs.bokio.se/reference/list-credit-notes-v1). A sales register
 * read from /invoices alone has none of them, and the rows /invoices does
 * carry for a credit document (status `credit`) name no credited invoice.
 * These pin the two list paths the migration uses (the direct list and the
 * job worker's page), the dedupe between the endpoints, the scope failure
 * modes, and that hydration asks /credit-notes/{id} for a credit note.
 */

const COMPANY = 'ea9ee4dd-fae3-4aec-a7db-6fc9cc1f8135';
// BOKIO_BASE_URL is https://api.bokio.se/v1, so every request path carries the version.
const BASE = `/v1/companies/${COMPANY}`;

const INVOICE = {
  id: 'a419cf69-db6f-4de9-992c-b1a60942a443',
  invoiceNumber: 'IN-2024-001',
  status: 'credited',
  invoiceDate: '2024-10-01',
  dueDate: '2024-10-31',
  currency: 'SEK',
  totalAmount: 6375,
  totalTax: 1275,
  paidAmount: 0,
  customerRef: { id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'customer 1' },
  lineItems: [{ id: 1, description: 'Product 1', quantity: 2, unitPrice: 100, taxRate: 25 }],
  creditNoteRefs: [{ id: 'b529df79-eb7f-5ef0-a8dc-c2b71f953554' }],
};

const SECOND_INVOICE = { ...INVOICE, id: 'c0ffee00-0000-4000-8000-000000000002', invoiceNumber: 'IN-2024-002', status: 'paid', creditNoteRefs: [] };

const CREDIT_NOTE = {
  id: 'b529df79-eb7f-5ef0-a8dc-c2b71f953554',
  status: 'published',
  invoiceNumber: 'CN-2024-001',
  invoiceRef: { id: INVOICE.id, invoiceNumber: 'IN-2024-001' },
  customerRef: { id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'customer 1' },
  currency: 'SEK',
  currencyRate: 1,
  totalAmount: 6375,
  totalTax: 1275,
  paidAmount: 0,
  creditDate: '2024-10-15',
  dueDate: '2024-11-15',
  lineItems: [
    { id: 1, description: 'Product 1', quantity: 2, unitPrice: 100, taxRate: 25 },
    { id: 2, description: 'Installation work', unitType: 'hour', quantity: 10, unitPrice: 500, taxRate: 25 },
  ],
};

/** The same credit note as /invoices lists it: invoice shape, status credit, no invoiceRef. */
const CREDIT_AS_INVOICE = {
  id: CREDIT_NOTE.id,
  invoiceNumber: 'CN-2024-001',
  status: 'credit',
  invoiceDate: '2024-10-15',
  dueDate: '2024-11-15',
  currency: 'SEK',
  totalAmount: 6375,
  totalTax: 1275,
  paidAmount: 0,
  customerRef: CREDIT_NOTE.customerRef,
  lineItems: CREDIT_NOTE.lineItems,
};

function paged(items: unknown[], page = 1, totalPages = items.length ? 1 : 0, totalItems = items.length) {
  return Response.json({ items, currentPage: page, totalPages, totalItems });
}

function status(code: number) {
  return new Response('', { status: code, statusText: 'Refused' });
}

function stubBokio(route: (url: URL) => Response | undefined): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    expect(url.hostname).toBe('api.bokio.se');
    requested.push(url.pathname + url.search);
    return route(url) ?? status(404);
  }));
  return requested;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchSalesInvoicesDirect (bokio)', () => {
  it('lists /credit-notes beside /invoices and returns the credit notes first, typed 381 with the credited invoice named', async () => {
    const requested = stubBokio((url) => {
      if (url.pathname === `${BASE}/invoices`) return paged([INVOICE]);
      if (url.pathname === `${BASE}/credit-notes`) return paged([CREDIT_NOTE]);
      return undefined;
    });

    const result = await fetchSalesInvoicesDirect('bokio', 'tok', COMPANY);

    expect(requested).toContain(`${BASE}/credit-notes?page=1&pageSize=100`);
    expect(result.map((dto) => dto.invoiceNumber)).toEqual(['CN-2024-001', 'IN-2024-001']);
    expect(result[0]).toMatchObject({
      invoiceTypeCode: '381',
      issueDate: '2024-10-15',
      status: 'credited',
      creditedInvoiceRef: { id: INVOICE.id, invoiceNumber: 'IN-2024-001' },
    });
    expect(result[1]).toMatchObject({ status: 'credited' });
    expect(result[1].invoiceTypeCode).toBeUndefined();
  });

  it('prefers the /credit-notes form when /invoices lists the same document under status credit', async () => {
    stubBokio((url) => {
      if (url.pathname === `${BASE}/invoices`) return paged([INVOICE, CREDIT_AS_INVOICE]);
      if (url.pathname === `${BASE}/credit-notes`) return paged([CREDIT_NOTE]);
      return undefined;
    });

    const result = await fetchSalesInvoicesDirect('bokio', 'tok', COMPANY);

    expect(result).toHaveLength(2);
    const creditNotes = result.filter((dto) => dto.invoiceTypeCode === '381');
    expect(creditNotes).toHaveLength(1);
    expect(creditNotes[0].creditedInvoiceRef).toEqual({ id: INVOICE.id, invoiceNumber: 'IN-2024-001' });
  });

  it('still types an /invoices row of status credit as a credit note when /credit-notes does not list it', async () => {
    stubBokio((url) => {
      if (url.pathname === `${BASE}/invoices`) return paged([CREDIT_AS_INVOICE]);
      if (url.pathname === `${BASE}/credit-notes`) return paged([]);
      return undefined;
    });

    const [only] = await fetchSalesInvoicesDirect('bokio', 'tok', COMPANY);

    expect(only.invoiceTypeCode).toBe('381');
    expect(only.status).toBe('credited');
    expect(only.creditedInvoiceRef).toBeUndefined();
  });

  it('reads a 404 on /credit-notes as an absent resource and keeps the invoices', async () => {
    stubBokio((url) => {
      if (url.pathname === `${BASE}/invoices`) return paged([INVOICE]);
      if (url.pathname === `${BASE}/credit-notes`) return status(404);
      return undefined;
    });

    const result = await fetchSalesInvoicesDirect('bokio', 'tok', COMPANY);

    expect(result.map((dto) => dto.invoiceNumber)).toEqual(['IN-2024-001']);
  });

  it('propagates a refused credit-notes scope instead of silently dropping the register', async () => {
    stubBokio((url) => {
      if (url.pathname === `${BASE}/invoices`) return paged([INVOICE]);
      if (url.pathname === `${BASE}/credit-notes`) return status(403);
      return undefined;
    });

    const error = await fetchSalesInvoicesDirect('bokio', 'tok', COMPANY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BokioApiError);
    expect((error as BokioApiError).statusCode).toBe(403);
  });
});

describe('fetchMigrationPage (bokio, salesInvoices)', () => {
  it('rides the whole credit-note register on page 1, ahead of the invoices, and only there', async () => {
    const requested = stubBokio((url) => {
      const page = Number(url.searchParams.get('page'));
      if (url.pathname === `${BASE}/invoices`) return paged(page === 1 ? [INVOICE] : [SECOND_INVOICE], page, 2, 2);
      if (url.pathname === `${BASE}/credit-notes`) return paged([CREDIT_NOTE]);
      return undefined;
    });

    const first = await fetchMigrationPage('bokio', 'tok', COMPANY, 'salesInvoices', 1);
    expect((first.items as SalesInvoiceDto[]).map((dto) => dto.invoiceNumber)).toEqual(['CN-2024-001', 'IN-2024-001']);
    expect((first.items[0] as SalesInvoiceDto).invoiceTypeCode).toBe('381');
    expect(first.nextPage).toBe(2);
    expect(first.total).toBe(3);

    const second = await fetchMigrationPage('bokio', 'tok', COMPANY, 'salesInvoices', 2);
    expect((second.items as SalesInvoiceDto[]).map((dto) => dto.invoiceNumber)).toEqual(['IN-2024-002']);
    expect(second.nextPage).toBeNull();

    expect(requested.filter((path) => path.startsWith(`${BASE}/credit-notes`))).toHaveLength(1);
  });

  it('leaves the supplier-invoice page alone', async () => {
    const requested = stubBokio((url) => {
      if (url.pathname === `${BASE}/supplier-invoices`) return paged([]);
      return undefined;
    });

    await fetchMigrationPage('bokio', 'tok', COMPANY, 'supplierInvoices', 1);

    expect(requested.some((path) => path.includes('/credit-notes'))).toBe(false);
  });
});

describe('hydrateSalesInvoices (bokio)', () => {
  it('asks /credit-notes/{id} for a credit note and keeps its type code and reference', async () => {
    const listForm = { ...CREDIT_NOTE, lineItems: undefined, totalTax: undefined };
    const listed = mapBokioToSalesInvoice(listForm as unknown as Record<string, unknown>);
    expect(listed.lines).toHaveLength(0);

    const requested = stubBokio((url) => {
      if (url.pathname === `${BASE}/credit-notes/${CREDIT_NOTE.id}`) return Response.json(CREDIT_NOTE);
      return undefined;
    });

    const { invoices, unhydratedIds } = await hydrateSalesInvoices('bokio', 'tok', COMPANY, [listed], 5_000);

    expect(requested).toEqual([`${BASE}/credit-notes/${CREDIT_NOTE.id}`]);
    expect(unhydratedIds.size).toBe(0);
    expect(invoices[0]).toMatchObject({
      invoiceTypeCode: '381',
      creditedInvoiceRef: { id: INVOICE.id, invoiceNumber: 'IN-2024-001' },
    });
    expect(invoices[0].lines).toHaveLength(2);
  });
});
