import { describe, expect, it } from 'vitest';
import { mapVismaToSalesInvoice } from '../mapper';

/**
 * CustomerInvoiceApi (eAccounting API v2) states each header amount twice:
 * `TotalAmount`, `TotalVatAmount` and `RemainingAmount` "expressed in base
 * currency", and `TotalAmountInvoiceCurrency`, `TotalVatAmountInvoiceCurrency`
 * and `RemainingAmountInvoiceCurrency` in the invoice currency. The rows
 * (`AmountNoVat`) are priced in the invoice currency. The DTO reports amounts
 * in `currencyCode`, so a foreign invoice has to be read from the
 * invoice-currency family, or its SEK figures are stored as euros.
 */
const euroInvoice = {
  Id: 'eur-1',
  InvoiceNumber: 2001,
  InvoiceDate: '2026-08-05',
  CurrencyCode: 'EUR',
  CurrencyRate: 10.9925,
  TotalAmount: 274812.5,
  TotalVatAmount: 54962.5,
  TotalAmountInvoiceCurrency: 25000,
  TotalVatAmountInvoiceCurrency: 5000,
  RemainingAmount: 0,
  RemainingAmountInvoiceCurrency: 0,
  PaymentStatus: 0,
  InvoiceCustomerName: 'Kund AB',
  Rows: [
    { LineNumber: 1, Text: 'Konsulttjänst', Quantity: 1, UnitPrice: 20000, AmountNoVat: 20000, PercentVat: 25 },
  ],
};

describe('mapVismaToSalesInvoice: invoice currency', () => {
  it('reports a foreign invoice in its own currency, not the base-currency totals', () => {
    const dto = mapVismaToSalesInvoice(euroInvoice);

    expect(dto.currencyCode).toBe('EUR');
    expect(dto.legalMonetaryTotal.payableAmount).toEqual({ value: 25000, currencyCode: 'EUR' });
    expect(dto.legalMonetaryTotal.lineExtensionAmount).toEqual({ value: 20000, currencyCode: 'EUR' });
    expect(dto.taxTotal?.taxAmount).toEqual({ value: 5000, currencyCode: 'EUR' });
  });

  it('agrees with its own rows', () => {
    const dto = mapVismaToSalesInvoice(euroInvoice);
    const rowNet = dto.lines.reduce((sum, line) => sum + line.lineExtensionAmount.value, 0);

    expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(rowNet);
  });

  it('reads the open balance of an unpaid foreign invoice in the invoice currency', () => {
    const dto = mapVismaToSalesInvoice({
      ...euroInvoice,
      PaymentStatus: 1,
      RemainingAmount: 109925,
      RemainingAmountInvoiceCurrency: 10000,
    });

    expect(dto.paymentStatus?.paid).toBe(false);
    expect(dto.paymentStatus?.balance).toEqual({ value: 10000, currencyCode: 'EUR' });
  });

  it('leaves the net unknown when the invoice-currency VAT is missing, never mixing the families', () => {
    const { TotalVatAmountInvoiceCurrency: _omitted, ...withoutVat } = euroInvoice;
    const dto = mapVismaToSalesInvoice(withoutVat);

    expect(dto.legalMonetaryTotal.payableAmount.value).toBe(25000);
    expect(dto.legalMonetaryTotal.lineExtensionAmount).toBeUndefined();
    expect(dto.taxTotal).toBeUndefined();
  });

  it('reads a foreign invoice without PaymentStatus as paid when its base balance is 0', () => {
    const { RemainingAmountInvoiceCurrency: _omitted, PaymentStatus: _ps, ...withoutTwin } = euroInvoice;
    const dto = mapVismaToSalesInvoice(withoutTwin);

    expect(dto.paymentStatus?.paid).toBe(true);
    expect(dto.paymentStatus?.balance).toEqual({ value: 0, currencyCode: 'EUR' });
  });

  it('never takes a base-currency balance for a foreign invoice', () => {
    const { RemainingAmountInvoiceCurrency: _omitted, ...withoutTwin } = euroInvoice;
    const dto = mapVismaToSalesInvoice({ ...withoutTwin, PaymentStatus: 1, RemainingAmount: 109925 });

    expect(dto.paymentStatus?.balance).toEqual({ value: 25000, currencyCode: 'EUR' });
  });

  it('reads a SEK invoice from the base family even when only some twins are present', () => {
    const dto = mapVismaToSalesInvoice({
      Id: 'sek-2',
      InvoiceNumber: 2003,
      InvoiceDate: '2026-08-05',
      CurrencyCode: 'SEK',
      TotalAmount: 1250,
      TotalVatAmount: 250,
      TotalAmountInvoiceCurrency: 1250,
      RemainingAmount: 500,
      PaymentStatus: 1,
      InvoiceCustomerName: 'Kund AB',
    });

    expect(dto.taxTotal?.taxAmount.value).toBe(250);
    expect(dto.paymentStatus?.balance.value).toBe(500);
  });

  it('keeps a SEK invoice as it was, with or without the twins', () => {
    const sek = {
      Id: 'sek-1',
      InvoiceNumber: 2002,
      InvoiceDate: '2026-08-05',
      CurrencyCode: 'SEK',
      TotalAmount: 1250,
      TotalVatAmount: 250,
      RemainingAmount: 1250,
      PaymentStatus: 1,
      InvoiceCustomerName: 'Kund AB',
    };
    const withTwins = mapVismaToSalesInvoice({
      ...sek,
      TotalAmountInvoiceCurrency: 1250,
      TotalVatAmountInvoiceCurrency: 250,
      RemainingAmountInvoiceCurrency: 1250,
    });
    const withoutTwins = mapVismaToSalesInvoice(sek);

    for (const dto of [withTwins, withoutTwins]) {
      expect(dto.legalMonetaryTotal.payableAmount.value).toBe(1250);
      expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000);
      expect(dto.taxTotal?.taxAmount.value).toBe(250);
      expect(dto.paymentStatus?.balance.value).toBe(1250);
    }
  });
});
