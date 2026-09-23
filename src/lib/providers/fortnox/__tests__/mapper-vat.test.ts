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

describe('mapFortnoxToSalesInvoice: VATIncluded rows', () => {
  // Profilio (2026-09-05): a 956 kr invoice priced with VAT inside. Its rows
  // were stored as if net, summing to 956 with 25 % on top, beside a header
  // that read 764.80 + 191.20 correctly.
  const inclusive = {
    DocumentNumber: 241,
    InvoiceDate: '2025-06-02',
    Currency: 'SEK',
    Total: 956,
    Balance: 0,
    FullyPaid: true,
    Net: 764.8,
    TotalVAT: 191.2,
    VATIncluded: true,
  };

  it('converts VAT-inclusive row amounts to net, unit price included', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...inclusive,
      InvoiceRows: [
        { RowId: 1, Description: 'Mugg', DeliveredQuantity: 3, Price: 200, Total: 600, VAT: 25 },
        { RowId: 2, Description: 'Frakt', DeliveredQuantity: 1, Price: 356, Total: 356, VAT: 25 },
      ],
    });

    expect(dto.lines.map((l) => l.lineExtensionAmount.value)).toEqual([480, 284.8]);
    expect(dto.lines.map((l) => l.unitPrice?.value)).toEqual([160, 284.8]);
    expect(dto.lines.map((l) => l.taxAmount?.value)).toEqual([120, 71.2]);
    const rowsNet = dto.lines.reduce((s, l) => s + l.lineExtensionAmount.value, 0);
    expect(rowsNet).toBeCloseTo(764.8, 2);
    // The header is unaffected: it always came from Net / TotalVAT.
    expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(764.8);
  });

  it('prefers the net the row states itself when the payload carries it', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...inclusive,
      InvoiceRows: [
        { RowId: 1, Price: 956, PriceExcludingVAT: 764.8, Total: 956, TotalExcludingVAT: 764.8, VAT: 25 },
      ],
    });

    expect(dto.lines[0]?.lineExtensionAmount.value).toBe(764.8);
    expect(dto.lines[0]?.unitPrice?.value).toBe(764.8);
  });

  it('leaves rows alone when the invoice is priced excluding VAT', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...inclusive,
      VATIncluded: false,
      InvoiceRows: [{ RowId: 1, Price: 764.8, Total: 764.8, VAT: 25 }],
    });

    expect(dto.lines[0]?.lineExtensionAmount.value).toBe(764.8);
    expect(dto.lines[0]?.unitPrice?.value).toBe(764.8);
  });

  it('cannot split a VAT-inclusive row without a rate and keeps the amount', () => {
    // Text rows and rows without VAT carry no rate; nothing to divide by. The
    // consumer's rows-versus-header check is what reports such an invoice.
    const dto = mapFortnoxToSalesInvoice({
      ...inclusive,
      InvoiceRows: [{ RowId: 1, Description: 'Referens', Total: 0 }, { RowId: 2, Total: 956 }],
    });

    expect(dto.lines.map((l) => l.lineExtensionAmount.value)).toEqual([0, 956]);
    expect(dto.lines[1]?.taxAmount).toBeUndefined();
  });
});

describe('mapFortnoxToSalesInvoice: header-level freight and fee', () => {
  // Live shapes from Profilio (2026-09-05). Fortnox keeps freight and the
  // administration fee on the header: `Net` excludes them, `Total` and
  // `TotalVAT` include them, and the *VAT fields are amounts, not rates.
  const base = {
    DocumentNumber: 295,
    InvoiceDate: '2026-04-02',
    Currency: 'SEK',
    Balance: 0,
    FullyPaid: true,
    AdministrationFee: 0,
    AdministrationFeeVAT: 0,
  };

  it('adds a freight row net of VAT on an invoice priced excluding VAT', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...base,
      VATIncluded: false,
      Total: 9504,
      Net: 7515.2,
      TotalVAT: 1900.8,
      Freight: 88,
      FreightVAT: 22,
      InvoiceRows: [
        { RowId: 687, Description: 'Hoodie', DeliveredQuantity: '14', Price: 359.2, PriceExcludingVAT: 359.2, Total: 5028.8, TotalExcludingVAT: 5028.8, VAT: 25 },
        { RowId: 689, Description: 'T-shirt', DeliveredQuantity: '12', Price: 207.2, PriceExcludingVAT: 207.2, Total: 2486.4, TotalExcludingVAT: 2486.4, VAT: 25 },
      ],
    });

    const freight = dto.lines.at(-1);
    expect(freight).toMatchObject({ id: 'freight', description: 'Frakt', quantity: 1, taxPercent: 25 });
    expect(freight?.lineExtensionAmount.value).toBe(88);
    expect(freight?.taxAmount?.value).toBe(22);
    // Rows now add up to the header net the migration derives (gross - VAT).
    const rowsNet = dto.lines.reduce((s, l) => s + l.lineExtensionAmount.value, 0);
    expect(rowsNet).toBeCloseTo(9504 - 1900.8, 2);
  });

  it('reads the freight as gross when the invoice is priced including VAT', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...base,
      DocumentNumber: 242,
      VATIncluded: true,
      Total: 2327.8,
      Net: 1783.04,
      TotalVAT: 465.56,
      Freight: 99,
      FreightVAT: 19.8,
      InvoiceRows: [
        { RowId: 544, Description: 'Carnegie-tshirts', DeliveredQuantity: '14', Price: 199, PriceExcludingVAT: 159.2, Total: 2228.8, TotalExcludingVAT: 1783.04, VAT: 25, Discount: 20, DiscountType: 'PERCENT' },
        { RowId: 548, Description: '20 % rabatt på grund av försenad leverans.', DeliveredQuantity: '0', Price: 0, PriceExcludingVAT: 0, Total: 0, TotalExcludingVAT: 0, VAT: 0 },
      ],
    });

    const freight = dto.lines.at(-1);
    expect(freight?.lineExtensionAmount.value).toBe(79.2);
    expect(freight?.taxAmount?.value).toBe(19.8);
    expect(freight?.taxPercent).toBe(25);
    const rowsNet = dto.lines.reduce((s, l) => s + l.lineExtensionAmount.value, 0);
    expect(rowsNet).toBeCloseTo(2327.8 - 465.56, 2);
  });

  it('adds no row when the header carries no charge', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...base,
      VATIncluded: true,
      Total: 956,
      Net: 764.8,
      TotalVAT: 191.2,
      Freight: 0,
      FreightVAT: 0,
      InvoiceRows: [{ RowId: 541, Description: 'Hoodie', DeliveredQuantity: '1', Price: 419, PriceExcludingVAT: 335.2, Total: 419, TotalExcludingVAT: 335.2, VAT: 25 }],
    });

    expect(dto.lines).toHaveLength(1);
  });

  it('adds an administration fee row the same way', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...base,
      VATIncluded: false,
      Total: 1311,
      Net: 1000,
      TotalVAT: 262.25,
      Freight: 0,
      FreightVAT: 0,
      AdministrationFee: 49,
      AdministrationFeeVAT: 12.25,
      InvoiceRows: [{ RowId: 1, Total: 1000, TotalExcludingVAT: 1000, VAT: 25 }],
    });

    const fee = dto.lines.at(-1);
    expect(fee).toMatchObject({ id: 'administration-fee', description: 'Administrationsavgift', taxPercent: 25 });
    expect(fee?.lineExtensionAmount.value).toBe(49);
    expect(fee?.taxAmount?.value).toBe(12.25);
  });

  it('reads the string quantity Fortnox serialises as a number', () => {
    const dto = mapFortnoxToSalesInvoice({
      ...base,
      VATIncluded: false,
      Total: 1250,
      Net: 1000,
      TotalVAT: 250,
      Freight: 0,
      FreightVAT: 0,
      InvoiceRows: [{ RowId: 1, DeliveredQuantity: '14', Total: 1000, TotalExcludingVAT: 1000, VAT: 25 }],
    });

    expect(dto.lines[0]?.quantity).toBe(14);
  });
});
