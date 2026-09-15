import { describe, expect, it } from 'vitest';
import { mapBokioToCompanyInformation, mapBokioToSupplierInvoice } from '../mapper';

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
