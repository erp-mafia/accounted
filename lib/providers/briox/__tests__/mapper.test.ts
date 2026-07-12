import { describe, it, expect } from 'vitest';
import {
  mapBrioxToSalesInvoice,
  mapBrioxToSupplierInvoice,
  mapBrioxToCustomer,
  mapBrioxToAccountingAccount,
  mapBrioxToCompanyInformation,
} from '../mapper';

/**
 * Mirrors lib/providers/fortnox/__tests__/mapper-payment-status.test.ts:
 * deriveInvoiceStatus and paymentStatus.paid share one isFullyPaid() source
 * of truth, so status === 'paid' iff paymentStatus.paid. An ABSENT balance
 * must never be read as paid. Field names follow the Briox docs (snake_case);
 * re-verify against sandbox payloads (plan Phase 3).
 */

function salesRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    invoice_number: '1001',
    invoice_date: '2026-01-10',
    due_date: '2026-02-10',
    total_amount: 1000,
    net_amount: 800,
    customer_name: 'Kund AB',
    booked: true,
    ...over,
  };
}

function supplierRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    invoice_number: 'L-55',
    invoice_date: '2026-01-10',
    total_amount: 1000,
    supplier_name: 'Leverantör AB',
    booked: true,
    ...over,
  };
}

describe('Briox mapper: paid-status consistency', () => {
  it('sales: absent balance is NOT paid (defaults to full total, not 0)', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({})); // no balance key
    expect(dto.status).toBe('booked');
    expect(dto.paymentStatus.paid).toBe(false);
    expect(dto.paymentStatus.balance.value).toBe(1000);
  });

  it('sales: balance 0 with positive total → paid and status paid', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({ balance: 0 }));
    expect(dto.status).toBe('paid');
    expect(dto.paymentStatus.paid).toBe(true);
    expect(dto.paymentStatus.balance.value).toBe(0);
  });

  it('sales: positive balance → unpaid', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({ balance: 250 }));
    expect(dto.status).toBe('booked');
    expect(dto.paymentStatus.paid).toBe(false);
    expect(dto.paymentStatus.balance.value).toBe(250);
  });

  it('sales: string amounts ("0.00", "250.00") are coerced', () => {
    const paid = mapBrioxToSalesInvoice(salesRaw({ total_amount: '1000.00', balance: '0.00' }));
    expect(paid.status).toBe('paid');
    expect(paid.paymentStatus.paid).toBe(true);

    const open = mapBrioxToSalesInvoice(salesRaw({ total_amount: '1000.00', balance: '250.00' }));
    expect(open.paymentStatus.paid).toBe(false);
    expect(open.paymentStatus.balance.value).toBe(250);
    expect(open.legalMonetaryTotal.taxInclusiveAmount?.value).toBe(1000);
  });

  it('sales: fully_paid flag with absent balance keeps status and paid consistent', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({ fully_paid: true }));
    expect(dto.status).toBe('paid');
    expect(dto.paymentStatus.paid).toBe(true);
    // paid ⇒ no outstanding balance even though the payload omits balance
    expect(dto.paymentStatus.balance.value).toBe(0);
  });

  it('sales: explicit status "paid" wins even without amounts', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({ status: 'paid' }));
    expect(dto.status).toBe('paid');
    expect(dto.paymentStatus.paid).toBe(true);
  });

  it('sales: zero-total invoice with balance 0 is NOT marked paid', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({ total_amount: 0, balance: 0, booked: false }));
    expect(dto.status).toBe('draft');
    expect(dto.paymentStatus.paid).toBe(false);
  });

  it('sales: cancelled/credited status outranks settled amounts', () => {
    expect(mapBrioxToSalesInvoice(salesRaw({ status: 'cancelled', balance: 0 })).status).toBe('cancelled');
    expect(mapBrioxToSalesInvoice(salesRaw({ status: 'credited', balance: 0 })).status).toBe('credited');
  });

  it('sales: sent and overdue statuses derive when unpaid', () => {
    expect(mapBrioxToSalesInvoice(salesRaw({ booked: false, sent: true, balance: 1000 })).status).toBe('sent');
    expect(mapBrioxToSalesInvoice(salesRaw({ booked: false, status: 'overdue', balance: 1000 })).status).toBe('overdue');
  });

  it('supplier: absent balance is NOT paid (no false-paid on the supplier path)', () => {
    const dto = mapBrioxToSupplierInvoice(supplierRaw({}));
    expect(dto.status).toBe('booked');
    expect(dto.paymentStatus.paid).toBe(false);
    expect(dto.paymentStatus.balance.value).toBe(1000);
  });

  it('supplier: balance 0 → paid with zero balance', () => {
    const dto = mapBrioxToSupplierInvoice(supplierRaw({ balance: 0 }));
    expect(dto.status).toBe('paid');
    expect(dto.paymentStatus.paid).toBe(true);
    expect(dto.paymentStatus.balance.value).toBe(0);
  });
});

describe('Briox mapper: line mapping', () => {
  it('maps invoice rows to lines with stringified account numbers', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({
      rows: [
        {
          id: 1,
          description: 'Konsulttimmar',
          quantity: 10,
          unit: 'h',
          price: 80,
          total: 800,
          vat_rate: 25,
          account_number: 3041,
          article_number: 'A-1',
        },
        { description: 'Frakt', total: 200 },
      ],
    }));

    expect(dto.lines).toHaveLength(2);
    expect(dto.lines[0]).toMatchObject({
      id: '1',
      description: 'Konsulttimmar',
      quantity: 10,
      unitCode: 'h',
      taxPercent: 25,
      accountNumber: '3041',
      articleNumber: 'A-1',
    });
    expect(dto.lines[0].lineExtensionAmount.value).toBe(800);
    // Row without id falls back to its 1-based index
    expect(dto.lines[1].id).toBe('2');
    expect(dto.lines[1].accountNumber).toBeUndefined();
  });

  it('coerces string line-level price/total/quantity/vat_rate (Briox serializes numbers as strings)', () => {
    const dto = mapBrioxToSalesInvoice(salesRaw({
      rows: [
        {
          id: 1,
          description: 'Konsulttimmar',
          quantity: '10',
          price: '250.00',
          total: '2500.00',
          vat_rate: '25',
        },
      ],
    }));

    expect(dto.lines[0].quantity).toBe(10);
    expect(dto.lines[0].unitPrice?.value).toBe(250);
    expect(dto.lines[0].lineExtensionAmount.value).toBe(2500);
    expect(dto.lines[0].taxPercent).toBe(25);
  });

  it('supplier: coerces string line-level amounts too', () => {
    const dto = mapBrioxToSupplierInvoice(supplierRaw({
      rows: [
        { id: 1, description: 'Material', quantity: '2', price: '125.50', total: '251.00' },
      ],
    }));

    expect(dto.lines[0].quantity).toBe(2);
    expect(dto.lines[0].unitPrice?.value).toBe(125.5);
    expect(dto.lines[0].lineExtensionAmount.value).toBe(251);
  });
});

describe('Briox mapper: customers', () => {
  it('maps org number, payment terms and address', () => {
    const dto = mapBrioxToCustomer({
      id: 12,
      customer_number: 'K100',
      name: 'Kund AB',
      org_number: '5560000000',
      payment_terms_days: '30',
      address1: 'Storgatan 1',
      zip_code: '111 22',
      city: 'Stockholm',
      email: 'kund@example.se',
      modified_date: '2026-01-01',
    });

    expect(dto.customerNumber).toBe('K100');
    expect(dto.party.identifications[0]).toEqual({ id: '5560000000', schemeId: 'SE:ORGNR' });
    expect(dto.defaultPaymentTermsDays).toBe(30);
    expect(dto.party.postalAddress?.streetName).toBe('Storgatan 1');
    expect(dto.active).toBe(true);
  });
});

describe('Briox mapper: accounts', () => {
  it('uses id as account number, description as name, incoming_balance as opening balance', () => {
    const dto = mapBrioxToAccountingAccount({
      id: 1930,
      description: 'Företagskonto',
      active: '1',
      incoming_balance: '12500.50',
    });

    expect(dto.accountNumber).toBe('1930');
    expect(dto.name).toBe('Företagskonto');
    expect(dto.type).toBe('asset');
    expect(dto.active).toBe(true);
    expect(dto.balanceCarriedForward).toBe(12500.5);
  });

  it('treats active "0" (string) as inactive', () => {
    expect(mapBrioxToAccountingAccount({ id: 3041, description: 'Försäljning', active: '0' }).active).toBe(false);
    expect(mapBrioxToAccountingAccount({ id: 3041, description: 'Försäljning', active: '1' }).active).toBe(true);
    expect(mapBrioxToAccountingAccount({ id: 3041, description: 'Försäljning', active: false }).active).toBe(false);
  });

  it('derives the account type from the BAS class', () => {
    expect(mapBrioxToAccountingAccount({ id: 1510, description: 'Kundfordringar' }).type).toBe('asset');
    expect(mapBrioxToAccountingAccount({ id: 2440, description: 'Leverantörsskulder' }).type).toBe('liability');
    expect(mapBrioxToAccountingAccount({ id: 3041, description: 'Försäljning' }).type).toBe('revenue');
    expect(mapBrioxToAccountingAccount({ id: 6570, description: 'Bankkostnader' }).type).toBe('expense');
  });
});

describe('Briox mapper: company information', () => {
  it('unwraps the /user/info envelope and reads accounts[0]', () => {
    const dto = mapBrioxToCompanyInformation({
      info: {
        company_name: 'Testbolaget AB',
        accounts: [
          {
            database_label: 'Testbolaget AB',
            organization_number: '5560000000',
            email: 'info@testbolaget.se',
            address: {
              addressline1: 'Storgatan 1',
              zip: '111 22',
              city: 'Stockholm',
              countrycode: 'SE',
            },
          },
        ],
      },
    });

    expect(dto.companyName).toBe('Testbolaget AB');
    expect(dto.organizationNumber).toBe('5560000000');
    expect(dto.address?.streetName).toBe('Storgatan 1');
    expect(dto.address?.postalZone).toBe('111 22');
    expect(dto.address?.countryCode).toBe('SE');
    expect(dto.contact?.email).toBe('info@testbolaget.se');
  });

  it('falls back to database_label when company_name is missing', () => {
    const dto = mapBrioxToCompanyInformation({
      info: { accounts: [{ database_label: 'Mitt Bolag', organization_number: '5561111111' }] },
    });
    expect(dto.companyName).toBe('Mitt Bolag');
  });
});
