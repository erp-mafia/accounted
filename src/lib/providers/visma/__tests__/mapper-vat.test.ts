import { describe, expect, it } from 'vitest';
import { mapVismaToSalesInvoice, mapVismaToSupplierInvoice } from '../mapper';

/**
 * eAccounting's `TotalAmount` INCLUDES VAT. It used to be reported as the
 * ex-VAT `lineExtensionAmount`, so every migrated Visma invoice recorded its
 * gross as its net and 0 kr of VAT. The row reader asked for `LineTotal` and
 * `VatRatePercent`, neither of which is in the schema, so lines landed at 0
 * with a hardcoded 25 %.
 */
describe('mapVismaToSalesInvoice: VAT', () => {
  const base = {
    Id: 'abc',
    InvoiceNumber: 10205,
    InvoiceDate: '2024-02-29',
    CurrencyCode: 'SEK',
    TotalAmount: 106462.5,
    TotalVatAmount: 21292.5,
    InvoiceCustomerName: 'Kund AB',
  };

  it('never reports the VAT-inclusive TotalAmount as the net', () => {
    const dto = mapVismaToSalesInvoice(base);

    expect(dto.legalMonetaryTotal.payableAmount.value).toBe(106462.5);
    expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(85170);
    expect(dto.taxTotal?.taxAmount.value).toBe(21292.5);
  });

  it('reads AmountNoVat and PercentVat from the rows', () => {
    const dto = mapVismaToSalesInvoice({
      ...base,
      Rows: [
        { LineNumber: 1, Text: 'Konsulttjänst', Quantity: 1, UnitPrice: 85170, AmountNoVat: 85170, PercentVat: 25 },
      ],
    });

    expect(dto.lines[0]?.lineExtensionAmount.value).toBe(85170);
    expect(dto.lines[0]?.taxPercent).toBe(25);
    expect(dto.lines[0]?.taxAmount?.value).toBe(21292.5);
  });

  it('falls back to unit price x quantity when AmountNoVat is absent', () => {
    const dto = mapVismaToSalesInvoice({
      ...base,
      Rows: [{ LineNumber: 1, Quantity: 2, UnitPrice: 500, PercentVat: 25 }],
    });

    expect(dto.lines[0]?.lineExtensionAmount.value).toBe(1000);
    expect(dto.lines[0]?.taxAmount?.value).toBe(250);
  });

  it('leaves the net unknown when the payload states no VAT total', () => {
    const { TotalVatAmount: _omitted, ...withoutVat } = base;
    const dto = mapVismaToSalesInvoice(withoutVat);

    expect(dto.legalMonetaryTotal.lineExtensionAmount).toBeUndefined();
    expect(dto.taxTotal).toBeUndefined();
  });
});

describe('mapVismaToSupplierInvoice: VAT', () => {
  it('reads TotalVatAmount rather than treating the gross as the net', () => {
    const dto = mapVismaToSupplierInvoice({
      Id: 'sup-1',
      InvoiceNumber: 500,
      InvoiceDate: '2025-01-15',
      CurrencyCode: 'SEK',
      TotalAmount: 1250,
      TotalVatAmount: 250,
      SupplierName: 'Leverantör AB',
      PaymentStatus: 3,
    });

    expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000);
    expect(dto.taxTotal?.taxAmount.value).toBe(250);
  });
});
