import { describe, expect, it } from 'vitest';
import { mapFortnoxToSalesInvoice, mapFortnoxToSupplierInvoice } from '../mapper';

/**
 * Fortnox answers `GET /3/invoices` with the short form and
 * `GET /3/invoices/{n}` with the full one. Only the full form carries `Net`,
 * `TotalVAT` and `InvoiceRows`, and the migration used to map the short form
 * alone: 8 686 invoices landed claiming 25 % moms with 0 kr of it.
 */
describe('mapFortnoxToSalesInvoice: VAT', () => {
  const listForm = {
    DocumentNumber: 4,
    InvoiceDate: '2025-11-01',
    DueDate: '2025-12-01',
    CustomerName: 'Ronaldiniho',
    Currency: 'SEK',
    Total: 1845000,
    Balance: 1845000,
    Sent: true,
  };

  it('reports the net and VAT as UNKNOWN for the list form', () => {
    const dto = mapFortnoxToSalesInvoice(listForm);

    // Not "net equals gross, VAT is 0": the short form simply did not say.
    expect(dto.legalMonetaryTotal.lineExtensionAmount).toBeUndefined();
    expect(dto.taxTotal).toBeUndefined();
    // The one figure the payload does establish survives.
    expect(dto.legalMonetaryTotal.payableAmount.value).toBe(1845000);
    expect(dto.lines).toEqual([]);
  });

  it('reads Net and TotalVAT from the detail form', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...listForm,
      Net: 1476000,
      TotalVAT: 369000,
      InvoiceRows: [
        { RowId: 1, Description: 'Konsultarvode', DeliveredQuantity: 1, Price: 1476000, Total: 1476000, VAT: 25 },
      ],
    });

    expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1476000);
    expect(dto.taxTotal?.taxAmount.value).toBe(369000);
  });

  it('derives per-line VAT from the row rate, which Fortnox states without the amount', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...listForm,
      Net: 1476000,
      TotalVAT: 369000,
      InvoiceRows: [
        { RowId: 1, Total: 1000000, VAT: 25 },
        { RowId: 2, Total: 476000, VAT: 25 },
      ],
    });

    // The booking engine sums these to post 2611; 0 here posts no output VAT.
    expect(dto.lines[0]?.taxAmount?.value).toBe(250000);
    expect(dto.lines[1]?.taxAmount?.value).toBe(119000);
    expect(dto.lines[0]?.taxPercent).toBe(25);
  });

  it('leaves line VAT unknown when the row states no rate', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...listForm,
      InvoiceRows: [{ RowId: 1, Total: 1000 }],
    });

    expect(dto.lines[0]?.taxAmount).toBeUndefined();
  });

  it('keeps a genuine 0 % row at 0, distinct from unknown', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...listForm,
      InvoiceRows: [{ RowId: 1, Total: 1000, VAT: 0 }],
    });

    expect(dto.lines[0]?.taxAmount?.value).toBe(0);
  });
});

describe('mapFortnoxToSupplierInvoice: VAT', () => {
  it('reports the net as unknown without Net, and reads it when present', () => {
    const base = {
      GivenNumber: 77,
      InvoiceDate: '2025-11-01',
      SupplierName: 'Leverantör AB',
      Currency: 'SEK',
      Total: 1250,
      Balance: 1250,
    };

    expect(mapFortnoxToSupplierInvoice(base).legalMonetaryTotal.lineExtensionAmount)
      .toBeUndefined();

    const detail = mapFortnoxToSupplierInvoice({ ...base, Net: 1000, TotalVAT: 250 });
    expect(detail.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000);
    expect(detail.taxTotal?.taxAmount.value).toBe(250);
  });
});
