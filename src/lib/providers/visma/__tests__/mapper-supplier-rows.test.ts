import { describe, expect, it } from 'vitest';
import { mapVismaToSupplierInvoice } from '../mapper';

/**
 * SupplierInvoiceApi `Rows` are the registration voucher's accounting rows,
 * each with its amount in DebetAmount or CreditAmount. The mapper read
 * `DebetAmount || CreditAmount`, so every credit row (the 2440 payable, an
 * öresavrundning credit, the utgående moms of a reverse-charge pair, the 2514
 * of a särskild löneskatt pair) came through as a debit, and no row set could
 * add up to its invoice. Rows now carry their side, debit positive, the way
 * Fortnox states them.
 */
describe('mapVismaToSupplierInvoice: rows', () => {
  const invoice = (rows: [number, number, number][], over: Record<string, unknown> = {}) =>
    mapVismaToSupplierInvoice({
      Id: 'sup-1', InvoiceNumber: '500', InvoiceDate: '2026-06-01', CurrencyCode: 'SEK', TotalAmount: 899,
      SupplierName: 'Leverantör AB', PaymentStatus: 3,
      Rows: rows.map(([account, debit, credit], i) => ({ LineNumber: i + 1, AccountNumber: account, DebetAmount: debit, CreditAmount: credit })),
      ...over,
    });

  it('states a debit row positive and a credit row negative', () => {
    const dto = invoice([[4000, 719.52, 0], [2641, 179.88, 0], [3740, 0, 0.40], [2440, 0, 899]]);

    expect(dto.lines.map((line) => [line.accountNumber, line.lineExtensionAmount.value])).toEqual([
      ['4000', 719.52], ['2641', 179.88], ['3740', -0.40], ['2440', -899],
    ]);
    expect(dto.lines.reduce((sum, line) => sum + line.lineExtensionAmount.value, 0)).toBeCloseTo(0, 10);
  });

  it('keeps a kreditfaktura reversed, the payable a debit', () => {
    const dto = invoice([[2440, 1250, 0], [4010, 0, 1000], [2641, 0, 250]], { IsCreditInvoice: true, TotalAmount: -1250 });

    expect(dto.invoiceTypeCode).toBe('381');
    expect(dto.lines.map((line) => [line.accountNumber, line.lineExtensionAmount.value])).toEqual([
      ['2440', 1250], ['4010', -1000], ['2641', -250],
    ]);
  });

  it('nets a row that states both sides, in whole öre', () => {
    const dto = invoice([[6540, 1000.1, 0.2], [2440, 0, 999.9]]);

    expect(dto.lines.map((line) => line.lineExtensionAmount.value)).toEqual([999.9, -999.9]);
  });
});
