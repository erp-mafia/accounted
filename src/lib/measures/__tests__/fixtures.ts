/**
 * One small aktiebolag for the measure tests: a 2026 räkenskapsår opened by
 * an opening-balance entry, sales and purchases with VAT, payments on three
 * bank accounts and a till, a momsredovisning, a year-end entry, a draft, and
 * open customer and supplier invoices. Every amount is chosen so the figures
 * can be checked by hand (see the comments on the expected values).
 */
import type { FakeLedgerData } from './fake-ledger'

export const CO = 'c0ffee00-0000-4000-8000-000000000001'
export const FP = 'f0000000-0000-4000-8000-000000002026'
export const OB = 'e0000000-0000-4000-8000-000000000000'
const E = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const CUS1 = 'c1000000-0000-4000-8000-000000000001'
export const CUS2 = 'c1000000-0000-4000-8000-000000000002'
export const SUP1 = 'b1000000-0000-4000-8000-000000000001'
export const INV1 = 'a1000000-0000-4000-8000-000000000001'
export const INV2 = 'a1000000-0000-4000-8000-000000000002'
export const SINV1 = 'b2000000-0000-4000-8000-000000000001'

export function fixtureData(overrides: Partial<FakeLedgerData> = {}): FakeLedgerData {
  return {
    companyId: CO,
    fiscalPeriods: [
      {
        id: FP,
        name: 'Räkenskapsår 2026',
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        is_closed: false,
        locked_at: null,
        closing_entry_id: null,
        closed_externally: false,
        opening_balance_entry_id: OB,
      },
    ],
    chart: [
      { account_number: '1229', account_name: 'Ackumulerade avskrivningar på inventarier', account_class: 1 },
      { account_number: '1510', account_name: 'Kundfordringar', account_class: 1 },
      { account_number: '1910', account_name: 'Kassa', account_class: 1 },
      { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
      { account_number: '1940', account_name: 'Övriga bankkonton', account_class: 1 },
      { account_number: '2081', account_name: 'Aktiekapital', account_class: 2 },
      { account_number: '2099', account_name: 'Årets resultat', account_class: 2 },
      { account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2 },
      { account_number: '2611', account_name: 'Utgående moms på försäljning inom Sverige, 25 %', account_class: 2 },
      { account_number: '2641', account_name: 'Debiterad ingående moms', account_class: 2 },
      { account_number: '2650', account_name: 'Redovisningskonto för moms', account_class: 2 },
      { account_number: '3001', account_name: 'Försäljning inom Sverige, 25 % moms', account_class: 3 },
      { account_number: '3911', account_name: 'Hyresintäkter', account_class: 3 },
      { account_number: '5010', account_name: 'Lokalhyra', account_class: 5 },
      { account_number: '6110', account_name: 'Kontorsmateriel', account_class: 6 },
      { account_number: '7832', account_name: 'Avskrivningar på inventarier', account_class: 7 },
      { account_number: '8410', account_name: 'Räntekostnader', account_class: 8 },
    ],
    entries: [
      {
        id: OB, entry_date: '2026-01-01', voucher_series: 'IB', voucher_number: 1, description: 'Ingående balans',
        source_type: 'opening_balance', fiscal_period_id: FP,
        lines: [
          { account_number: '1930', debit: 50000 },
          { account_number: '1510', debit: 12000 },
          { account_number: '1910', debit: 1000 },
          { account_number: '2440', credit: 8000 },
          { account_number: '2081', credit: 25000 },
          { account_number: '2099', credit: 30000 },
        ],
      },
      {
        id: E(1), entry_date: '2026-02-10', voucher_number: 1, description: 'Faktura 1001', source_type: 'invoice_created', fiscal_period_id: FP,
        lines: [
          { account_number: '1510', debit: 12500 },
          { account_number: '3001', credit: 10000 },
          { account_number: '2611', credit: 2500 },
        ],
      },
      {
        id: E(2), entry_date: '2026-02-20', voucher_number: 2, description: 'Hyra februari', source_type: 'supplier_invoice_registered', fiscal_period_id: FP,
        lines: [
          { account_number: '5010', debit: 8000 },
          { account_number: '2641', debit: 2000 },
          { account_number: '2440', credit: 10000 },
        ],
      },
      {
        id: E(3), entry_date: '2026-03-05', voucher_number: 3, description: 'Inbetalning gammal fordran', source_type: 'invoice_paid', fiscal_period_id: FP,
        lines: [
          { account_number: '1930', debit: 12000 },
          { account_number: '1510', credit: 12000 },
        ],
      },
      {
        id: E(4), entry_date: '2026-03-15', voucher_number: 4, description: 'Betalning leverantör', source_type: 'supplier_invoice_paid', fiscal_period_id: FP,
        lines: [
          { account_number: '2440', debit: 8000 },
          { account_number: '1930', credit: 8000 },
        ],
      },
      {
        id: E(5), entry_date: '2026-04-10', voucher_number: 5, description: 'Kontantförsäljning', source_type: 'bank_transaction', fiscal_period_id: FP,
        lines: [
          { account_number: '1940', debit: 6250 },
          { account_number: '3001', credit: 5000 },
          { account_number: '2611', credit: 1250 },
        ],
      },
      {
        id: E(6), entry_date: '2026-04-12', voucher_number: 6, description: 'Momsredovisning Q1', source_type: 'vat_settlement', fiscal_period_id: FP,
        lines: [
          { account_number: '2611', debit: 2500 },
          { account_number: '2641', credit: 2000 },
          { account_number: '2650', credit: 500 },
        ],
      },
      {
        id: E(7), entry_date: '2026-05-02', voucher_number: 7, description: 'Kontorsmaterial', source_type: 'bank_transaction', fiscal_period_id: FP,
        lines: [
          { account_number: '6110', debit: 400 },
          { account_number: '2641', debit: 100 },
          { account_number: '1930', credit: 500 },
        ],
      },
      {
        id: E(8), entry_date: '2026-05-20', voucher_number: 8, description: 'Hyresintäkt förråd', source_type: 'bank_transaction', fiscal_period_id: FP,
        lines: [
          { account_number: '1930', debit: 2000 },
          { account_number: '3911', credit: 2000 },
        ],
      },
      {
        id: E(9), entry_date: '2026-06-30', voucher_number: 9, description: 'Ränta', source_type: 'bank_transaction', fiscal_period_id: FP,
        lines: [
          { account_number: '8410', debit: 150 },
          { account_number: '1930', credit: 150 },
        ],
      },
      {
        id: E(10), entry_date: '2026-12-31', voucher_number: 10, description: 'Avskrivning inventarier', source_type: 'year_end', fiscal_period_id: FP,
        lines: [
          { account_number: '7832', debit: 1000 },
          { account_number: '1229', credit: 1000 },
        ],
      },
      {
        id: E(11), entry_date: '2026-06-15', voucher_number: 0, description: 'Utkast', source_type: 'manual', status: 'draft', fiscal_period_id: FP,
        lines: [
          { account_number: '6110', debit: 999 },
          { account_number: '1930', credit: 999 },
        ],
      },
    ],
    invoices: [
      {
        id: INV1, customer_id: CUS1, customer: { id: CUS1, name: 'Kund AB' }, document_type: 'invoice', status: 'sent',
        invoice_number: '1001', invoice_date: '2026-02-10', due_date: '2026-03-12', total: 12500, paid_amount: 0,
        currency: 'SEK', exchange_rate: null, deduction_total: 0,
      },
      {
        id: INV2, customer_id: CUS2, customer: { id: CUS2, name: 'Beta HB' }, document_type: 'invoice', status: 'partially_paid',
        invoice_number: '1002', invoice_date: '2026-10-01', due_date: '2026-11-30', total: 5000, paid_amount: 2000,
        currency: 'SEK', exchange_rate: null, deduction_total: 0,
      },
    ],
    supplierInvoices: [
      {
        id: SINV1, supplier_id: SUP1, supplier: { id: SUP1, name: 'Hyresvärden AB' }, status: 'registered',
        supplier_invoice_number: 'F-77', arrival_number: 3, invoice_date: '2026-02-20', due_date: '2026-03-20',
        total: 10000, remaining_amount: 10000, currency: 'SEK', exchange_rate: null,
      },
      {
        id: 'b2000000-0000-4000-8000-000000000002', supplier_id: SUP1, supplier: { id: SUP1, name: 'Hyresvärden AB' }, status: 'paid',
        supplier_invoice_number: 'F-70', arrival_number: 1, invoice_date: '2026-01-20', due_date: '2026-02-20',
        total: 8000, remaining_amount: 0, currency: 'SEK', exchange_rate: null,
      },
    ],
    cashAccounts: [
      { id: 'ca000000-0000-4000-8000-000000000001', ledger_account: '1930' },
      { id: 'ca000000-0000-4000-8000-000000000002', ledger_account: '1940' },
      { id: 'ca000000-0000-4000-8000-000000000003', ledger_account: '1686' },
    ],
    ...overrides,
  }
}
