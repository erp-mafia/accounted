/**
 * Kontantmetoden (bokslutsmetoden): an invoice unpaid at year end must reach
 * the momsdeklaration exactly ONCE.
 *
 * Skatteverket: "I den deklaration som avser sista redovisningsperioden för
 * beskattningsåret ska du även redovisa momsen på obetalda fakturor.
 * Betalningen styr alltså momsredovisningen förutom vid årsbokslutet. Tänk på
 * att inte redovisa de obetalda fakturorna dubbelt i nästa period."
 *
 * The scenario runs the real ledger shapes through the real VAT RPCs:
 *
 *   - year 1 (2026), quarterly moms, final period Q4 2026: one customer
 *     invoice 1 000 + 250 moms and one supplier invoice 400 + 100 moms, both
 *     unpaid on 2026-12-31. Under kontantmetoden neither touched the ledger;
 *   - the year-end cut-off verifikat built by buildCutoffLines() (1510 /
 *     3001 / 2618 and 6110 + 2648 / 2440), dated 2026-12-31, marked
 *     'receivable' / 'payable' the way postKontantmetodCutoff() marks them;
 *   - the vändningar built by reverseLines(), dated 2027-01-01 in the 2027
 *     räkenskapsår, marked 'receivable_reversal' / 'payable_reversal';
 *   - the new-year payments as the app books them: buildInvoiceCashLines()
 *     (1930 / 3001 / 2611, source 'invoice_cash_payment') on 2027-02-15 and
 *     buildSupplierInvoiceCashLines() (6110 + 2641 / 1930, source
 *     'supplier_invoice_cash_payment') on 2027-02-20. The payment flows have
 *     no knowledge of the cut-off (kontantmetod-cutoff.ts header: "a
 *     new-year payment still books the normal kontantmetoden cash entry").
 *
 * The RPCs count the cut-off in Q4 2026 and drop the vändning from 2027
 * (kontantmetod_cutoff_entries, 20260914150109 / 20260920182259), while the
 * payment counts again in Q1 2027. The cases marked `it.fails` below are the
 * failing reproduction of that double declaration on main: each states what
 * Skatteverket requires, and fails today. A fix flips them to `it`.
 *
 * Observed on main (15713c854): ruta 10 over 2027 = 250, ruta 05 over 2027 =
 * 1 000, ruta 48 over 2027 = 100 (all should be 0), and after the
 * momsredovisning proposal sweeps each quarter, 2618 is left at 250 debit and
 * 2648 at 100 credit forever while 2650 has been credited 300 instead of 150.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import {
  VAT_ACCOUNTS,
  VAT_INPUT_ACCOUNTS,
  VAT_OUTPUT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  rutorFromTotals,
} from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import {
  KONTANTMETOD_CUTOFF_DESCRIPTIONS,
  buildCutoffLines,
  reverseLines,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-lines'
import { buildSupplierInvoiceCashLines } from '@/lib/bookkeeping/supplier-invoice-entries'
import type {
  CreateJournalEntryLineInput,
  SupplierInvoice,
  SupplierInvoiceItem,
} from '@/types'

// Exactly what fetchVatAccountTotals passes for a company without its own
// ruta 05 accounts.
const P_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]
const P_RUTA_ACCOUNTS = VAT_ACCOUNTS
const P_NET_ACCOUNTS = VAT_SETTLEMENT_NET_ACCOUNTS

const YEAR1_FINAL_PERIOD = { start: '2026-10-01', end: '2026-12-31' }
const YEAR2_PERIODS = [
  { start: '2027-01-01', end: '2027-03-31' },
  { start: '2027-04-01', end: '2027-06-30' },
  { start: '2027-07-01', end: '2027-09-30' },
  { start: '2027-10-01', end: '2027-12-31' },
]

const CUSTOMER_NET = 1000
const CUSTOMER_VAT = 250
const SUPPLIER_NET = 400
const SUPPLIER_VAT = 100

type Totals = Map<string, { debit: number; credit: number }>

interface Scenario {
  userId: string
  companyId: string
  fy2026: string
  fy2027: string
  nextVoucher: () => number
}

function toFixtureLines(lines: CreateJournalEntryLineInput[]) {
  return lines.map((line) => ({
    accountNumber: line.account_number,
    debitAmount: line.debit_amount,
    creditAmount: line.credit_amount,
    lineDescription: line.line_description ?? null,
  }))
}

async function post(
  s: Scenario,
  params: {
    fiscalPeriodId: string
    entryDate: string
    description: string
    sourceType: string
    sourceId?: string | null
    lines: CreateJournalEntryLineInput[]
  },
): Promise<string> {
  return insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: s.nextVoucher(),
    entryDate: params.entryDate,
    description: params.description,
    sourceType: params.sourceType,
    sourceId: params.sourceId ?? null,
    lines: toFixtureLines(params.lines),
  })
}

async function mark(
  s: Scenario,
  kind: 'receivable' | 'receivable_reversal' | 'payable' | 'payable_reversal',
  journalEntryId: string,
): Promise<void> {
  // Same row postKontantmetodCutoff() records: fiscal_period_id is the year
  // being CLOSED for all four kinds, the vändningar included.
  await getPool().query(
    `INSERT INTO public.kontantmetod_cutoff_entries
       (company_id, fiscal_period_id, kind, journal_entry_id)
     VALUES ($1, $2, $3, $4)`,
    [s.companyId, s.fy2026, kind, journalEntryId],
  )
}

async function seedScenario(): Promise<Scenario> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method)
     VALUES ($1, $2, 'cash')`,
    [userId, companyId],
  )
  const fy2026 = await insertFiscalPeriod({
    userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31',
  })
  const fy2027 = await insertFiscalPeriod({
    userId, companyId, name: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31',
  })
  let voucher = 0
  const s: Scenario = { userId, companyId, fy2026, fy2027, nextVoucher: () => ++voucher }

  // ---- The year-end cut-off, as postKontantmetodCutoff() shapes it --------
  const cutoff = buildCutoffLines(
    [{
      id: 'cust-inv-1',
      reference: 'F-1001',
      vatTreatment: 'standard_25',
      outstanding: CUSTOMER_NET + CUSTOMER_VAT,
      vat: CUSTOMER_VAT,
    }],
    [{
      id: 'supp-inv-1',
      reference: 'LF-2001',
      outstanding: SUPPLIER_NET + SUPPLIER_VAT,
      vat: SUPPLIER_VAT,
      netByAccount: [{ account: '6110', amount: SUPPLIER_NET }],
    }],
    'aktiebolag',
  )
  // Pin the shape so a change to the builder is visible here, not silently
  // absorbed: 1510 D 1250 / 3001 K 1000 / 2618 K 250, 6110 D 400 + 2648 D 100
  // / 2440 K 500.
  const sig = (lines: CreateJournalEntryLineInput[]) =>
    lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]).sort()
  expect(sig(cutoff.receivableLines)).toEqual(
    [['1510', 1250, 0], ['2618', 0, 250], ['3001', 0, 1000]],
  )
  expect(sig(cutoff.payableLines)).toEqual(
    [['2440', 0, 500], ['2648', 100, 0], ['6110', 400, 0]],
  )

  const receivableId = await post(s, {
    fiscalPeriodId: fy2026,
    entryDate: '2026-12-31',
    description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable,
    sourceType: 'year_end',
    sourceId: fy2026,
    lines: cutoff.receivableLines,
  })
  await mark(s, 'receivable', receivableId)
  const receivableReversalId = await post(s, {
    fiscalPeriodId: fy2027,
    entryDate: '2027-01-01',
    description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal,
    sourceType: 'year_end',
    sourceId: fy2026,
    lines: reverseLines(cutoff.receivableLines),
  })
  await mark(s, 'receivable_reversal', receivableReversalId)

  const payableId = await post(s, {
    fiscalPeriodId: fy2026,
    entryDate: '2026-12-31',
    description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable,
    sourceType: 'year_end',
    sourceId: fy2026,
    lines: cutoff.payableLines,
  })
  await mark(s, 'payable', payableId)
  const payableReversalId = await post(s, {
    fiscalPeriodId: fy2027,
    entryDate: '2027-01-01',
    description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal,
    sourceType: 'year_end',
    sourceId: fy2026,
    lines: reverseLines(cutoff.payableLines),
  })
  await mark(s, 'payable_reversal', payableReversalId)

  // ---- Customer pays in February 2027: createInvoiceCashEntry's lines ------
  const customerCash = buildInvoiceCashLines(
    {
      id: '00000000-0000-4000-8000-000000001001',
      invoice_number: 'F-1001',
      currency: 'SEK',
      exchange_rate: null,
      vat_treatment: 'standard_25',
      delivery_country: null,
      subtotal: CUSTOMER_NET,
      subtotal_sek: CUSTOMER_NET,
      vat_amount: CUSTOMER_VAT,
      vat_amount_sek: CUSTOMER_VAT,
      total: CUSTOMER_NET + CUSTOMER_VAT,
      total_sek: CUSTOMER_NET + CUSTOMER_VAT,
    },
    'aktiebolag',
    'Kund AB',
  )
  expect(sig(customerCash.lines)).toEqual(
    [['1930', 1250, 0], ['2611', 0, 250], ['3001', 0, 1000]],
  )
  await post(s, {
    fiscalPeriodId: fy2027,
    entryDate: '2027-02-15',
    description: customerCash.description,
    sourceType: 'invoice_cash_payment',
    lines: customerCash.lines,
  })

  // ---- Supplier paid in February 2027: buildSupplierInvoiceCashLines -------
  const supplierInvoice = {
    id: '00000000-0000-4000-8000-000000002001',
    supplier_invoice_number: 'LF-2001',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: SUPPLIER_NET,
    subtotal_sek: SUPPLIER_NET,
    vat_amount: SUPPLIER_VAT,
    vat_amount_sek: SUPPLIER_VAT,
    total: SUPPLIER_NET + SUPPLIER_VAT,
    total_sek: SUPPLIER_NET + SUPPLIER_VAT,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    ore_rounding: null,
    paid_amount: 0,
    remaining_amount: SUPPLIER_NET + SUPPLIER_VAT,
    default_dimensions: null,
  } as unknown as SupplierInvoice
  const supplierItems = [{
    id: '00000000-0000-4000-8000-000000002002',
    supplier_invoice_id: supplierInvoice.id,
    sort_order: 0,
    description: 'Kontorsmaterial',
    quantity: 1,
    unit: 'st',
    unit_price: SUPPLIER_NET,
    line_total: SUPPLIER_NET,
    account_number: '6110',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: SUPPLIER_VAT,
    reverse_charge_rate: null,
  }] as unknown as SupplierInvoiceItem[]
  const supplierCash = buildSupplierInvoiceCashLines(
    supplierInvoice, supplierItems, 'swedish_business', { supplierName: 'Leverantör AB' },
  )
  expect(sig(supplierCash.lines)).toEqual(
    [['1930', 0, 500], ['2641', 100, 0], ['6110', 400, 0]],
  )
  await post(s, {
    fiscalPeriodId: fy2027,
    entryDate: '2027-02-20',
    description: supplierCash.description,
    sourceType: 'supplier_invoice_cash_payment',
    lines: supplierCash.lines,
  })

  return s
}

async function declarationTotals(
  companyId: string,
  period: { start: string; end: string },
): Promise<Totals> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1, $2, $3, $4, $5, $6) AS payload`,
    [companyId, period.start, period.end, P_ACCOUNTS, P_RUTA_ACCOUNTS, P_NET_ACCOUNTS],
  )
  const totals: Totals = new Map()
  for (const row of rows[0].payload.totals as Array<{ account_number: string; debit: number; credit: number }>) {
    totals.set(row.account_number, { debit: Number(row.debit) || 0, credit: Number(row.credit) || 0 })
  }
  return totals
}

async function rutor(companyId: string, period: { start: string; end: string }) {
  return rutorFromTotals(await declarationTotals(companyId, period))
}

async function year2Sum(companyId: string, box: 'ruta05' | 'ruta10' | 'ruta48') {
  let sum = 0
  for (const period of YEAR2_PERIODS) {
    sum = Math.round((sum + (await rutor(companyId, period))[box]) * 100) / 100
  }
  return sum
}

/** Signed (credit - debit) sum of the drill-down lines on `accounts`. */
async function drillDownNet(
  companyId: string,
  period: { start: string; end: string },
  accounts: string[],
): Promise<number> {
  const { rows } = await getPool().query<{ debit_amount: string; credit_amount: string }>(
    `SELECT * FROM public.get_vat_ruta_source_lines(
       $1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, period.start, period.end, accounts, P_RUTA_ACCOUNTS, P_NET_ACCOUNTS],
  )
  return Math.round(
    rows.reduce((sum, r) => sum + Number(r.credit_amount) - Number(r.debit_amount), 0) * 100,
  ) / 100
}

async function ledgerBalance(companyId: string, account: string, end: string): Promise<number> {
  // Signed debit - credit over every posted verifikat up to `end`.
  const { rows } = await getPool().query<{ balance: string | null }>(
    `SELECT sum(l.debit_amount - l.credit_amount) AS balance
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted'
        AND e.entry_date <= $2 AND l.account_number = $3`,
    [companyId, end, account],
  )
  return Number(rows[0].balance ?? 0)
}

/**
 * The momsredovisning verifikat buildVatSettlementProposal() proposes for a
 * period, mirrored line for line: every 26xx account the declaration reads is
 * cleared by its RPC total, the filed net goes to 2650 / 1650. Amounts here
 * are whole kronor, so no 3740 line arises.
 */
async function postSettlement(s: Scenario, fiscalPeriodId: string, period: { start: string; end: string }) {
  const totals = await declarationTotals(s.companyId, period)
  const lines: CreateJournalEntryLineInput[] = []
  for (const account of [...new Set([...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS])].sort()) {
    const t = totals.get(account)
    if (!t) continue
    const balance = Math.round((t.credit - t.debit) * 100) / 100
    if (balance > 0) lines.push({ account_number: account, debit_amount: balance, credit_amount: 0 })
    else if (balance < 0) lines.push({ account_number: account, debit_amount: 0, credit_amount: -balance })
  }
  if (lines.length === 0) return
  const { net } = buildFiledAmounts(rutorFromTotals(totals))
  if (net > 0) lines.push({ account_number: '2650', debit_amount: 0, credit_amount: net })
  else if (net < 0) lines.push({ account_number: '1650', debit_amount: -net, credit_amount: 0 })
  await post(s, {
    fiscalPeriodId,
    entryDate: period.end,
    description: `Momsredovisning ${period.start}..${period.end}`,
    sourceType: 'vat_settlement',
    lines,
  })
}

describe('kontantmetoden cut-off: an unpaid invoice is declared exactly once', () => {
  it('year 1 final period declares the unpaid invoices (ruta 05, 10, 48)', async () => {
    const s = await seedScenario()
    const q4 = await rutor(s.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta10).toBe(CUSTOMER_VAT)
    expect(q4.ruta05).toBe(CUSTOMER_NET)
    expect(q4.ruta48).toBe(SUPPLIER_VAT)
  })

  // FAILING REPRODUCTION on main (observed 250): the vändning's 2618 debit is
  // excluded while the February payment's 2611 credit counts, so the same 250
  // is declared again in Q1 2027. A fix flips this to `it`.
  it.fails('ruta 10 over every year-2 period is 0 for the invoice already declared at year end', async () => {
    const s = await seedScenario()
    expect(await year2Sum(s.companyId, 'ruta10')).toBe(0)
  })

  // FAILING REPRODUCTION on main (observed 1000): the vändning's 3001 debit is
  // excluded, the payment's 3001 credit counts.
  it.fails('ruta 05 over every year-2 period is 0 for the sale already declared at year end', async () => {
    const s = await seedScenario()
    expect(await year2Sum(s.companyId, 'ruta05')).toBe(0)
  })

  // FAILING REPRODUCTION on main (observed 100): input moms deducted on 2648
  // in Q4 2026 and again on 2641 at the February 2027 payment.
  it.fails('ruta 48 over every year-2 period is 0 for the purchase already deducted at year end', async () => {
    const s = await seedScenario()
    expect(await year2Sum(s.companyId, 'ruta48')).toBe(0)
  })

  // FAILING REPRODUCTION on main (observed 500 and 200): over both years.
  it.fails('across both years each moms amount is declared exactly once', async () => {
    const s = await seedScenario()
    const q4 = await rutor(s.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta10 + (await year2Sum(s.companyId, 'ruta10'))).toBe(CUSTOMER_VAT)
    expect(q4.ruta48 + (await year2Sum(s.companyId, 'ruta48'))).toBe(SUPPLIER_VAT)
  })

  // FAILING REPRODUCTION on main (observed 250): the drill-down substantiates
  // the same doubled figure, so it cannot be used to spot the error either.
  it.fails('the ruta 10 drill-down over year 2 nets to 0 as well', async () => {
    const s = await seedScenario()
    let net = 0
    for (const period of YEAR2_PERIODS) {
      net += await drillDownNet(s.companyId, period, ['2611', '2618'])
    }
    expect(net).toBe(0)
  })

  // FAILING REPRODUCTION on main (observed 2618 = +250 debit, 2648 = -100,
  // 2650 = -300). The momsredovisning sweeps only what the declaration
  // counts. The vändning's 2618 debit and 2648 credit are never counted, so
  // they are never swept: both accounts carry a balance into every later
  // year, and 2650 owes Skatteverket 300 for 150 of real net moms.
  it.fails('after each period is swept to 2650, 2618 and 2648 are back at zero and 2650 owes the net once', async () => {
    const s = await seedScenario()
    await postSettlement(s, s.fy2026, YEAR1_FINAL_PERIOD)
    for (const period of YEAR2_PERIODS) await postSettlement(s, s.fy2027, period)

    expect(await ledgerBalance(s.companyId, '2618', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(s.companyId, '2648', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(s.companyId, '2650', '2027-12-31')).toBe(-(CUSTOMER_VAT - SUPPLIER_VAT))
  })

  // Pins the observed main behaviour with exact numbers, so the report above
  // is a measured figure and not a reading of the SQL. A fix inverts these
  // values and should delete this case along with flipping the ones above.
  it('observed on main: the year-2 declaration repeats the year-end figures', async () => {
    const s = await seedScenario()
    expect(await year2Sum(s.companyId, 'ruta10')).toBe(CUSTOMER_VAT)
    expect(await year2Sum(s.companyId, 'ruta05')).toBe(CUSTOMER_NET)
    expect(await year2Sum(s.companyId, 'ruta48')).toBe(SUPPLIER_VAT)

    await postSettlement(s, s.fy2026, YEAR1_FINAL_PERIOD)
    for (const period of YEAR2_PERIODS) await postSettlement(s, s.fy2027, period)
    expect(await ledgerBalance(s.companyId, '2618', '2027-12-31')).toBe(CUSTOMER_VAT)
    expect(await ledgerBalance(s.companyId, '2648', '2027-12-31')).toBe(-SUPPLIER_VAT)
    expect(await ledgerBalance(s.companyId, '2650', '2027-12-31')).toBe(-2 * (CUSTOMER_VAT - SUPPLIER_VAT))
  })
})
