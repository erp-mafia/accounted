import { describe, expect, it } from 'vitest';
import {
  bokioUnit,
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

describe('mapBokioToSupplierInvoice invoice number', () => {
  const base = {
    id: '6f6b2f17-3c4a-4a69-9f2d-3f5d7e1b8c90',
    invoiceDate: '2023-10-01',
    currency: 'SEK',
    totalAmount: 1000,
    remainingAmount: 0,
    supplierRef: { id: 'sup-1', name: 'Leverantör AB' },
  };

  it('leaves a missing number empty instead of substituting the Bokio record id', () => {
    expect(mapBokioToSupplierInvoice({ ...base, invoiceNumber: null }).invoiceNumber).toBe('');
    expect(mapBokioToSupplierInvoice({ ...base }).invoiceNumber).toBe('');
  });

  it('keeps the supplier number, trimmed, and stringifies a numeric one', () => {
    expect(mapBokioToSupplierInvoice({ ...base, invoiceNumber: '  F-77 ' }).invoiceNumber).toBe('F-77');
    expect(mapBokioToSupplierInvoice({ ...base, invoiceNumber: 4711 }).invoiceNumber).toBe('4711');
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
    expect(result.lines[1]).toMatchObject({ quantity: 10, unitCode: 'tim', taxPercent: 25, lineType: 'product' });
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
    // Bokio numbers a credit note when it is published: a draft has no
    // number, and Bokio's record id is not one (crm#1084).
    expect(result.invoiceNumber).toBe('');
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

/**
 * A Bokio /invoices row in the shape the company-api spec documents
 * (docs.bokio.se/reference/get-invoices-invoiceid): lineItems is a oneOf of
 * salesInvoiceItem and descriptionOnlyInvoiceItem, each line an int64 id, a
 * sales line optionally made from an item (itemRef), and the description
 * line that explains it right after it (crm#1084).
 */
const BOKIO_INVOICE_WITH_TEXT_ROWS = {
  id: '8f2c1d3e-0b4a-4c5d-9e6f-7a8b9c0d1e2f',
  invoiceNumber: '1',
  status: 'paid',
  invoiceDate: '2025-04-01',
  dueDate: '2025-05-01',
  currency: 'EUR',
  currencyRate: 10.85,
  totalAmount: 1153,
  totalTax: 0,
  paidAmount: 1153,
  customerRef: { id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'customer 1' },
  lineItems: [
    {
      id: 101, itemRef: { id: '835ba700-b306-4bd9-8447-59207b6b0002', description: 'Consultancy' },
      description: 'Consultancy services', itemType: 'salesItem', productType: 'services',
      unitType: 'month', quantity: 0.5, unitPrice: 2000, taxRate: 0,
    },
    {
      id: 102, description: 'Laptop', itemType: 'salesItem', productType: 'goods',
      unitType: 'piece', quantity: 1, unitPrice: 100, taxRate: 0,
    },
    { id: 103, description: 'SEK 1085 excl VAT at the ECB rate', itemType: 'descriptionOnlyItem' },
    {
      id: 104, description: 'Train', itemType: 'salesItem', productType: 'services',
      unitType: 'unspecified', quantity: 1, unitPrice: 50, taxRate: 0,
    },
    { id: 105, description: 'SEK 542.50 excl VAT at the ECB rate', itemType: 'descriptionOnlyItem' },
    {
      id: 106, description: 'Mileage', itemType: 'salesItem', productType: 'services',
      unitType: 'mile', quantity: 2, unitPrice: 1.5, taxRate: 0,
    },
  ],
};

describe('mapBokioToSalesInvoice line items', () => {
  it('keeps Bokio\'s line order and takes the row kind from itemType', () => {
    const result = mapBokioToSalesInvoice(BOKIO_INVOICE_WITH_TEXT_ROWS);

    expect(result.lines.map((line) => line.id)).toEqual(['101', '102', '103', '104', '105', '106']);
    expect(result.lines.map((line) => line.lineType)).toEqual(['product', 'product', 'text', 'product', 'text', 'product']);
    expect(result.lines[2]).toMatchObject({ description: 'SEK 1085 excl VAT at the ECB rate', quantity: undefined });
    expect(result.lines[2].lineExtensionAmount.value).toBe(0);
  });

  it('maps unitType to Accounted units, and unspecified to no unit', () => {
    const result = mapBokioToSalesInvoice(BOKIO_INVOICE_WITH_TEXT_ROWS);

    expect(result.lines.map((line) => line.unitCode)).toEqual(['månad', 'st', undefined, '', undefined, 'mil']);
  });

  it('leaves the row kind to inference when itemType is absent', () => {
    const result = mapBokioToSalesInvoice({
      ...BOKIO_INVOICE_WITH_TEXT_ROWS,
      lineItems: [{ id: 1, description: 'Product 1', quantity: 1, unitPrice: 100, taxRate: 25 }],
    });
    expect(result.lines[0].lineType).toBeUndefined();
  });
});

describe('bokioUnit', () => {
  it.each([
    ['unspecified', ''],
    ['piece', 'st'],
    ['hour', 'tim'],
    ['day', 'dag'],
    ['month', 'månad'],
    ['week', 'vecka'],
    ['year', 'år'],
    ['minute', 'min'],
    ['kilogram', 'kg'],
    ['gram', 'g'],
    ['ton', 'ton'],
    ['liter', 'l'],
    ['meter', 'm'],
    ['centimeter', 'cm'],
    ['millimeter', 'mm'],
    ['kilometer', 'km'],
    ['mile', 'mil'],
    ['meterSquared', 'kvm'],
    ['meterCubic', 'm3'],
    ['hectar', 'ha'],
    ['megabyte', 'MB'],
    ['gigabyte', 'GB'],
    ['words', 'ord'],
  ])('maps %s to "%s"', (unitType, expected) => {
    expect(bokioUnit({ unitType })).toBe(expected);
  });

  it('takes a custom unit from customUnitType, trimmed and capped', () => {
    expect(bokioUnit({ unitType: 'custom', customUnitType: '  förp  ' })).toBe('förp');
    expect(bokioUnit({ unitType: 'custom', customUnitType: 'x'.repeat(40) })).toHaveLength(32);
    expect(bokioUnit({ unitType: 'custom' })).toBe('');
  });

  it('says nothing when the line states no unit, and keeps a value it does not know', () => {
    expect(bokioUnit({ itemType: 'descriptionOnlyItem' })).toBeUndefined();
    expect(bokioUnit({ unitType: 'lightyear' })).toBe('lightyear');
  });

  it('maps supplier invoice lines the same way', () => {
    const result = mapBokioToSupplierInvoice({
      id: 's-1', invoiceNumber: 'F-1', invoiceDate: '2025-01-10', currency: 'SEK', totalAmount: 125,
      lineItems: [{ description: 'Paper', quantity: 1, unitPrice: 100, unitType: 'piece', taxRate: 25 }],
    });
    expect(result.lines[0].unitCode).toBe('st');
  });
});

describe('mapBokioToSalesInvoice invoice number', () => {
  const draft = {
    ...BOKIO_INVOICE_WITH_TEXT_ROWS,
    id: 'cec22965-5dc1-4e13-bde6-4d51c7d7a680',
    invoiceNumber: null,
    status: 'draft',
    paidAmount: 0,
  };

  it('leaves an unnumbered draft without a number instead of using the Bokio id', () => {
    expect(mapBokioToSalesInvoice(draft).invoiceNumber).toBe('');
  });

  it('leaves an unnumbered cancelled draft without a number', () => {
    const result = mapBokioToSalesInvoice({ ...draft, status: 'cancelled' });
    expect(result.status).toBe('cancelled');
    expect(result.invoiceNumber).toBe('');
  });

  it('keeps the stated number, trimmed and stringified', () => {
    expect(mapBokioToSalesInvoice({ ...draft, invoiceNumber: ' 1042 ' }).invoiceNumber).toBe('1042');
    expect(mapBokioToSalesInvoice({ ...draft, invoiceNumber: 1042 }).invoiceNumber).toBe('1042');
  });

  it('keeps the id on an issued document without a number, which could not be stored with none', () => {
    const result = mapBokioToSalesInvoice({ ...draft, status: 'published' });
    expect(result.status).toBe('sent');
    expect(result.invoiceNumber).toBe('cec22965-5dc1-4e13-bde6-4d51c7d7a680');
  });
});
