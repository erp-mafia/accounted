import { describe, expect, it } from 'vitest';
import {
  isBokioCreditNotePayload,
  mapBokioToCompanyInformation,
  mapBokioToCreditNote,
  mapBokioToSalesInvoice,
  mapBokioToSupplierInvoice,
} from '../mapper';

describe('mapBokioToCompanyInformation', () => {
  it('maps the documented company-information v1 fields', () => {
    const result = mapBokioToCompanyInformation({
      id: '9b408943-7a1e-47ac-85a7-ac52b2c210d3',
      name: 'Testbolaget AB',
      organizationNumber: '556677-8899',
      companyType: 'limitedCompany',
      address: {
        line1: 'Testgatan 1',
        city: 'Göteborg',
        postalCode: '123 45',
        country: 'SE',
      },
    });

    expect(result).toMatchObject({
      companyName: 'Testbolaget AB',
      organizationNumber: '556677-8899',
      legalEntity: {
        registrationName: 'Testbolaget AB',
        companyId: '556677-8899',
      },
      address: {
        streetName: 'Testgatan 1',
        cityName: 'Göteborg',
        postalZone: '123 45',
        countryCode: 'SE',
      },
    });
  });
});

/**
 * Bokio's `supplierInvoiceGet` schema carries no status and no paidAmount:
 * the open balance (`remainingAmount`) is the only payment signal it
 * publishes. Reading the sales invoice's fields here instead is what left
 * 365 migrated invoices standing as "att attestera" (2026-09-14).
 */
describe('mapBokioToSupplierInvoice payment state', () => {
  const base = {
    id: '6f6b2f17-3c4a-4a69-9f2d-3f5d7e1b8c90',
    invoiceNumber: 'INV-001',
    invoiceDate: '2023-10-01',
    dueDate: '2023-10-15',
    currency: 'SEK',
    supplierRef: { id: 'sup-1', name: 'Leverantör AB' },
  };

  it('reads remainingAmount 0 beside a real total as settled', () => {
    const result = mapBokioToSupplierInvoice({ ...base, totalAmount: 1000, remainingAmount: 0 });

    expect(result.paymentStatus).toMatchObject({ paid: true, source: 'balance' });
    expect(result.paymentStatus.balance.value).toBe(0);
    expect(result.status).toBe('paid');
  });

  it('reads a partial remainingAmount as an open balance, not as paid', () => {
    const result = mapBokioToSupplierInvoice({ ...base, totalAmount: 1000, remainingAmount: 300 });

    expect(result.paymentStatus.paid).toBe(false);
    expect(result.paymentStatus.balance.value).toBe(300);
  });

  it('leaves the whole total outstanding when remainingAmount is absent', () => {
    const result = mapBokioToSupplierInvoice({ ...base, totalAmount: 1000 });

    expect(result.paymentStatus.paid).toBe(false);
    expect(result.paymentStatus.balance.value).toBe(1000);
  });

  it('does not call a 0 kr record settled', () => {
    const result = mapBokioToSupplierInvoice({ ...base, totalAmount: 0, remainingAmount: 0 });

    expect(result.paymentStatus.paid).toBe(false);
    expect(result.status).not.toBe('paid');
  });

  it('reports an unpaid invoice Bokio has booked as booked, and one it has not as sent', () => {
    const booked = mapBokioToSupplierInvoice({
      ...base,
      totalAmount: 1000,
      remainingAmount: 1000,
      journalEntryRef: { id: '2d8ce6b4-1f3a-46a5-8a9d-5b7f2c4e9d10' },
    });
    const unbooked = mapBokioToSupplierInvoice({
      ...base,
      totalAmount: 1000,
      remainingAmount: 1000,
      journalEntryRef: null,
    });

    expect(booked.status).toBe('booked');
    expect(unbooked.status).toBe('sent');
  });
});

/**
 * Shaped like `creditNoteResponseWithDiscount` in Bokio's published
 * company-api spec (github.com/bokio/bokio-api, branch v1,
 * api-specification/company-api.yaml; docs.bokio.se/reference/list-credit-notes-v1).
 * Credit notes are a resource of their own (/credit-notes), dated by
 * creditDate, stated in magnitudes, and name the credited invoice in
 * invoiceRef. Mapping them as sales invoices without a type code is how a
 * Bokio customer's kreditfakturor showed up as "Ej skickad" (crm#110).
 */
const BOKIO_CREDIT_NOTE = {
  id: 'b529df79-eb7f-5ef0-a8dc-c2b71f953554',
  status: 'published',
  invoiceNumber: 'CN-2024-001',
  invoiceRef: { id: 'a419cf69-db6f-4de9-992c-b1a60942a443', invoiceNumber: 'IN-2024-001' },
  customerRef: { id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'customer 1', customerNumber: 'CUST-001' },
  contactDetailRef: { id: 'd3b07384-d9a0-4c9b-8b3a-6e1f2a5c8d4e', email: 'contact@customer1.com', phone: '+46701234567' },
  currency: 'SEK',
  currencyRate: 1,
  totalAmount: 6375,
  totalTax: 1275,
  paidAmount: 0,
  creditDate: '2024-10-15',
  dueDate: '2024-11-15',
  publishedDateTime: '2024-10-15T12:00:00',
  lineItems: [
    { id: 1, description: 'Product 1', itemType: 'salesItem', productType: 'goods', quantity: 2, unitPrice: 100, taxRate: 25, discount: { type: 'amount', value: 100 } },
    { id: 2, description: 'Installation work', itemType: 'salesItem', productType: 'services', unitType: 'hour', quantity: 10, unitPrice: 500, taxRate: 25 },
  ],
  journalEntryRef: { id: '340a4af0-edfd-47b1-b4ab-f30450eaac19' },
};

describe('mapBokioToCreditNote', () => {
  it('maps a published credit note to a 381 document that names the invoice it credits', () => {
    const result = mapBokioToCreditNote(BOKIO_CREDIT_NOTE);

    expect(result).toMatchObject({
      id: 'b529df79-eb7f-5ef0-a8dc-c2b71f953554',
      invoiceNumber: 'CN-2024-001',
      issueDate: '2024-10-15',
      dueDate: '2024-11-15',
      invoiceTypeCode: '381',
      creditedInvoiceRef: { id: 'a419cf69-db6f-4de9-992c-b1a60942a443', invoiceNumber: 'IN-2024-001' },
      status: 'credited',
      currencyCode: 'SEK',
      customer: { name: 'customer 1' },
    });
    // Magnitudes, as Bokio states them: the importer applies the sign once.
    expect(result.legalMonetaryTotal.payableAmount.value).toBe(6375);
    expect(result.taxTotal?.taxAmount.value).toBe(1275);
    expect(result.legalMonetaryTotal.lineExtensionAmount?.value).toBe(5100);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toMatchObject({ quantity: 10, unitCode: 'hour', taxPercent: 25 });
    expect(result.lines[1].lineExtensionAmount.value).toBe(5000);
  });

  it('keeps a draft credit note a draft and copes with a missing number and reference', () => {
    const result = mapBokioToCreditNote({
      ...BOKIO_CREDIT_NOTE,
      status: 'draft',
      invoiceNumber: null,
      invoiceRef: undefined,
      publishedDateTime: null,
    });

    expect(result.status).toBe('draft');
    expect(result.invoiceTypeCode).toBe('381');
    expect(result.creditedInvoiceRef).toBeUndefined();
    // Same fallback as an unnumbered draft invoice: the id stands in.
    expect(result.invoiceNumber).toBe('b529df79-eb7f-5ef0-a8dc-c2b71f953554');
  });

  it('is reached through the sales mapper, so a hydrated detail form keeps its type code', () => {
    // The fetcher applies one resource mapper to list and detail payloads
    // alike; a credit note re-mapped as an invoice would lose its 381.
    expect(isBokioCreditNotePayload(BOKIO_CREDIT_NOTE)).toBe(true);
    expect(isBokioCreditNotePayload({ id: 'x', invoiceDate: '2024-10-01', lineItems: [] })).toBe(false);
    expect(isBokioCreditNotePayload(null)).toBe(false);

    const viaSales = mapBokioToSalesInvoice(BOKIO_CREDIT_NOTE);
    expect(viaSales).toEqual(mapBokioToCreditNote(BOKIO_CREDIT_NOTE));
  });
});

/**
 * Bokio's `invoice.status` enum: draft, published, paid, overPaid,
 * underPaid, overdue, credited, credit. The old mapper knew five of them and
 * dropped the rest to 'draft' ("Ej skickad" once migrated).
 */
describe('mapBokioToSalesInvoice status', () => {
  const base = {
    id: 'a419cf69-db6f-4de9-992c-b1a60942a443',
    invoiceNumber: 'IN-2024-001',
    invoiceDate: '2024-10-01',
    dueDate: '2024-10-31',
    currency: 'SEK',
    totalAmount: 1250,
    totalTax: 250,
    paidAmount: 0,
    customerRef: { id: 'c-1', name: 'customer 1' },
    lineItems: [{ id: 1, description: 'Product 1', quantity: 1, unitPrice: 1000, taxRate: 25 }],
  };

  it.each([
    ['draft', 'draft'],
    ['published', 'sent'],
    ['paid', 'paid'],
    ['overPaid', 'paid'],
    ['underPaid', 'sent'],
    ['overdue', 'overdue'],
    ['credited', 'credited'],
    ['credit', 'credited'],
  ])('maps Bokio status %s to %s', (bokio, expected) => {
    expect(mapBokioToSalesInvoice({ ...base, status: bokio }).status).toBe(expected);
  });

  it('reads an invoice that has been credited as credited, not as a credit note', () => {
    const result = mapBokioToSalesInvoice({
      ...base,
      status: 'credited',
      creditNoteRefs: [{ id: 'b529df79-eb7f-5ef0-a8dc-c2b71f953554' }],
    });
    expect(result.status).toBe('credited');
    expect(result.invoiceTypeCode).toBeUndefined();
    expect(result.legalMonetaryTotal.payableAmount.value).toBe(1250);
  });

  it('marks an /invoices row Bokio labels credit as a credit note, without a credited reference', () => {
    const result = mapBokioToSalesInvoice({ ...base, status: 'credit' });
    expect(result.invoiceTypeCode).toBe('381');
    expect(result.status).toBe('credited');
    expect(result.creditedInvoiceRef).toBeUndefined();
  });

  it('keeps the open balance of an underpaid invoice', () => {
    const result = mapBokioToSalesInvoice({ ...base, status: 'underPaid', paidAmount: 500 });
    expect(result.status).toBe('sent');
    expect(result.paymentStatus.paid).toBe(false);
    expect(result.paymentStatus.balance.value).toBe(750);
  });
});
