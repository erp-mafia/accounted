/**
 * Kontantmetoden (bokslutsmetoden): an invoice unpaid at year end must reach
 * the momsdeklaration exactly ONCE (#3440).
 *
 * Skatteverket: "I den deklaration som avser sista redovisningsperioden för
 * beskattningsåret ska du även redovisa momsen på obetalda fakturor.
 * Betalningen styr alltså momsredovisningen förutom vid årsbokslutet. Tänk på
 * att inte redovisa de obetalda fakturorna dubbelt i nästa period."
 *
 * The scenarios run the real ledger shapes through the real VAT RPCs
 * (get_vat_declaration_totals, get_vat_ruta_source_lines), unchanged by the
 * fix:
 *
 *   - year 1 (2026), final VAT period Q4 2026: customer invoice F, 1 000 + 250
 *     moms, and supplier invoice L, 400 + 100 moms, both unpaid on 2026-12-31;
 *   - the year-end cut-off is årsomföring: one year_end verifikat per invoice
 *     built by buildKontantmetodCarryLines() (C: 1510 / 3001 / 2611, C_s:
 *     6110 + 2641 / 2440, ordinary moms accounts), dated 2026-12-31 and
 *     linked to its invoice through record_kontantmetod_cutoff_link
 *     (20261018131100). There is no vändning;
 *   - because the invoice is linked, the year-2 payment is a clearing like
 *     any faktureringsmetod payment: Dr 1930 / Cr 1510 (source invoice_paid)
 *     and buildSupplierInvoicePaymentLines' Dr 2440 / Cr 1930. No revenue,
 *     cost or moms is booked again.
 *
 * Before the fix the cut-off posted aggregate verifikat with a day-one
 * vändning the VAT RPCs excluded, and the year-2 payment booked revenue and
 * moms again, so ruta 05, 10 and 48 were declared in both years. That shape
 * stays on self-hosted installations that posted it; the last describe pins
 * that its posted figures are unchanged by the fix.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import {
  PERIOD_END,
  insertCustomerInvoice,
  insertSupplierInvoice,
  markReversed,
  nextSeq,
  postStorno,
  recordLink,
  seedCashCompany,
  type CashCompany,
} from './kontantmetod-carry-fixtures'
import {
  VAT_ACCOUNTS,
  VAT_INPUT_ACCOUNTS,
  VAT_OUTPUT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  rutorFromTotals,
} from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import {
  KONTANTMETOD_CARRY_SUPPLIER_STATUSES,
  KONTANTMETOD_CUTOFF_DESCRIPTIONS,
  buildCutoffLines,
  buildKontantmetodCarryLines,
  buildPaidBeforePostingCorrectionLines,
  kontantmetodCarryDescription,
  reverseLines,
  type CustomerCarrySource,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { buildCreditNoteLines, buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-lines'
import { chartVatTreatmentsOf } from '@/lib/bookkeeping/vat-entries'
import {
  buildSupplierInvoiceCashLines,
  buildSupplierInvoicePaymentLines,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import type {
  CreateJournalEntryLineInput,
  InvoiceItem,
  SupplierInvoice,
  SupplierInvoiceItem,
} from '@/types'

// Exactly what fetchVatAccountTotals passes for a company without its own
// ruta 05 accounts.
const P_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]
const P_RUTA_ACCOUNTS = VAT_ACCOUNTS
const P_NET_ACCOUNTS = VAT_SETTLEMENT_NET_ACCOUNTS

type Period = { start: string; end: string }
type Box = 'ruta05' | 'ruta10' | 'ruta21' | 'ruta30' | 'ruta48'

const YEAR1_FINAL_PERIOD: Period = { start: '2026-10-01', end: '2026-12-31' }

function lastDay(year: number, month: number): string {
  // month is 1-based; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function monthly(year: number): Period[] {
  return Array.from({ length: 12 }, (_, i) => ({
    start: `${year}-${String(i + 1).padStart(2, '0')}-01`,
    end: lastDay(year, i + 1),
  }))
}

function quarterly(year: number): Period[] {
  return [0, 3, 6, 9].map((m) => ({
    start: `${year}-${String(m + 1).padStart(2, '0')}-01`,
    end: lastDay(year, m + 3),
  }))
}

function annual(year: number): Period[] {
  return [{ start: `${year}-01-01`, end: `${year}-12-31` }]
}

const YEAR2_QUARTERS = quarterly(2027)

const CUSTOMER_NET = 1000
const CUSTOMER_VAT = 250
const CUSTOMER_TOTAL = CUSTOMER_NET + CUSTOMER_VAT
const SUPPLIER_NET = 400
const SUPPLIER_VAT = 100
const SUPPLIER_TOTAL = SUPPLIER_NET + SUPPLIER_VAT

const ENTITY = 'aktiebolag' as const

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

function toFixtureLines(lines: CreateJournalEntryLineInput[]) {
  return lines.map((line) => ({
    accountNumber: line.account_number,
    debitAmount: line.debit_amount,
    creditAmount: line.credit_amount,
    lineDescription: line.line_description ?? null,
  }))
}

const sig = (lines: CreateJournalEntryLineInput[]) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]).sort()

const netOn = (lines: CreateJournalEntryLineInput[], account: string) =>
  lines
    .filter((l) => l.account_number === account)
    .reduce((s, l) => Math.round((s + l.debit_amount - l.credit_amount) * 100) / 100, 0)

async function post(
  company: CashCompany,
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
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate: params.entryDate,
    description: params.description,
    sourceType: params.sourceType,
    sourceId: params.sourceId ?? null,
    lines: toFixtureLines(params.lines),
  })
}

async function insertPaymentRow(
  company: CashCompany,
  side: 'customer' | 'supplier',
  invoiceId: string,
  paymentDate: string,
  amount: number,
  journalEntryId: string,
): Promise<string> {
  const sql = side === 'customer'
    ? `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, 'SEK', $6) RETURNING id`
    : `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, 'SEK', $6) RETURNING id`
  const { rows } = await getPool().query<{ id: string }>(sql, [
    company.userId, company.companyId, invoiceId, paymentDate, amount, journalEntryId,
  ])
  return rows[0].id
}

/**
 * correctEntry's writes on E, in its order: the storno of E (source_type
 * storno, reverses_id), the rättelse K (source_type correction,
 * correction_of_id), then the CAS that marks E reversed. All on `date`.
 */
async function correctLike(
  company: CashCompany,
  entryId: string,
  correctedLines: CreateJournalEntryLineInput[],
  date: string,
  fiscalPeriodId: string,
): Promise<{ stornoId: string; correctionId: string }> {
  const stornoId = await postStorno(company, entryId, { date, fiscalPeriodId })
  const correctionId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, source_id, correction_of_id, status)
       SELECT $1, e.user_id, e.company_id, $2, $3, 'A', $4,
              'Rättelse: betald efter bokslut, årsomföring kontantmetoden',
              'correction', e.source_id, e.id, 'draft'
       FROM public.journal_entries e WHERE e.id = $5`,
      [correctionId, fiscalPeriodId, nextSeq() % 1_000_000_000, date, entryId],
    )
    for (const [index, line] of correctedLines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
         VALUES ($1, $2, $3, $4, 'SEK', $5)`,
        [correctionId, line.account_number, line.debit_amount, line.credit_amount, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correctionId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await markReversed(entryId, stornoId)
  return { stornoId, correctionId }
}

// ---------------------------------------------------------------------------
// Builder sources (the invoice rows as the carry builder reads them)
// ---------------------------------------------------------------------------

function customerItem(invoiceId: string, over: Record<string, unknown> = {}): InvoiceItem {
  return {
    id: randomUUID(),
    invoice_id: invoiceId,
    sort_order: 0,
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: CUSTOMER_NET,
    line_total: CUSTOMER_NET,
    vat_rate: 25,
    vat_amount: CUSTOMER_VAT,
    ...over,
  } as unknown as InvoiceItem
}

function customerSource(invoiceId: string, over: Partial<CustomerCarrySource> = {}): CustomerCarrySource {
  return {
    id: invoiceId,
    invoice_number: 'F-1001',
    invoice_date: '2026-11-15',
    status: 'sent',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    delivery_country: null,
    subtotal: CUSTOMER_NET,
    subtotal_sek: CUSTOMER_NET,
    vat_amount: CUSTOMER_VAT,
    vat_amount_sek: CUSTOMER_VAT,
    total: CUSTOMER_TOTAL,
    total_sek: CUSTOMER_TOTAL,
    items: [customerItem(invoiceId)],
    default_dimensions: null,
    ...over,
  }
}

function supplierSource(
  supplierInvoiceId: string,
  over: Record<string, unknown> = {},
  items?: Array<Record<string, unknown>>,
): { invoice: SupplierInvoice; items: SupplierInvoiceItem[] } {
  const invoice = {
    id: supplierInvoiceId,
    supplier_invoice_number: 'LF-2001',
    arrival_number: 2001,
    invoice_date: '2026-11-20',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: SUPPLIER_NET,
    subtotal_sek: SUPPLIER_NET,
    vat_amount: SUPPLIER_VAT,
    vat_amount_sek: SUPPLIER_VAT,
    total: SUPPLIER_TOTAL,
    total_sek: SUPPLIER_TOTAL,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    ore_rounding: null,
    paid_amount: 0,
    remaining_amount: SUPPLIER_TOTAL,
    is_credit_note: false,
    default_dimensions: null,
    ...over,
  } as unknown as SupplierInvoice
  const rows = items ?? [{}]
  return {
    invoice,
    items: rows.map((row, index) => ({
      id: randomUUID(),
      supplier_invoice_id: supplierInvoiceId,
      sort_order: index,
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
      ...row,
    })) as unknown as SupplierInvoiceItem[],
  }
}

// ---------------------------------------------------------------------------
// The cut-off and the year-2 doors, as the app books them
// ---------------------------------------------------------------------------

/** One carry verifikat C for a customer invoice, posted and linked. */
async function carryCustomer(
  company: CashCompany,
  invoiceId: string,
  source: CustomerCarrySource,
  amounts: { outstanding?: number; customerShare?: number } = {},
): Promise<{ carryId: string; lines: CreateJournalEntryLineInput[] }> {
  const outstanding = amounts.outstanding ?? Number(source.total)
  const reference = source.invoice_number ?? 'F'
  const built = buildKontantmetodCarryLines(
    {
      side: 'customer',
      invoice: source,
      reference,
      creditNote: false,
      outstandingOwn: outstanding,
      customerShareOwn: amounts.customerShare ?? outstanding,
    },
    ENTITY,
  )
  expect(built.mode).toBe('full')
  const carryId = await post(company, {
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: PERIOD_END,
    description: kontantmetodCarryDescription('customer', reference, false),
    sourceType: 'year_end',
    sourceId: company.fiscalPeriodId,
    lines: built.lines,
  })
  const link = await recordLink(company, { journalEntryId: carryId, invoiceId })
  expect(link).toMatchObject({ ok: true, kind: 'receivable_invoice' })
  return { carryId, lines: built.lines }
}

/** One carry verifikat C_s for a supplier invoice, posted and linked. */
async function carrySupplier(
  company: CashCompany,
  supplierInvoiceId: string,
  source: { invoice: SupplierInvoice; items: SupplierInvoiceItem[] },
  supplierType = 'swedish_business',
): Promise<{ carryId: string; lines: CreateJournalEntryLineInput[] }> {
  const reference = source.invoice.supplier_invoice_number ?? 'LF'
  // The company's momskoder, as the cut-off reads them (fetchChartVatTreatments)
  // for a reverse-charge invoice.
  const chart = source.invoice.reverse_charge
    ? chartVatTreatmentsOf((await getPool().query(
        `SELECT account_number, default_vat_treatment, default_vat_rate
           FROM public.chart_of_accounts
          WHERE company_id = $1 AND account_class IN (4, 5, 6) AND default_vat_treatment IS NOT NULL`,
        [company.companyId],
      )).rows)
    : undefined
  const built = buildKontantmetodCarryLines(
    {
      side: 'supplier',
      invoice: source.invoice,
      items: source.items,
      supplierType,
      chart,
      reference,
      creditNote: false,
      outstandingOwn: Number(source.invoice.total),
      totalOwn: Number(source.invoice.total),
    },
    ENTITY,
  )
  expect(built.mode).toBe('full')
  const carryId = await post(company, {
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: PERIOD_END,
    description: kontantmetodCarryDescription('supplier', reference, false),
    sourceType: 'year_end',
    sourceId: company.fiscalPeriodId,
    lines: built.lines,
  })
  const link = await recordLink(company, { journalEntryId: carryId, supplierInvoiceId })
  expect(link).toMatchObject({ ok: true, kind: 'payable_invoice' })
  return { carryId, lines: built.lines }
}

/** The year-2 customer payment on a linked invoice: a clearing of 1510. */
async function payCustomer(
  company: CashCompany,
  invoiceId: string,
  params: { date: string; amount: number; fiscalPeriodId: string },
): Promise<string> {
  const entryId = await post(company, {
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    description: 'Inbetalning kundfaktura F-1001',
    sourceType: 'invoice_paid',
    sourceId: invoiceId,
    lines: [
      { account_number: '1930', debit_amount: params.amount, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: params.amount },
    ],
  })
  await insertPaymentRow(company, 'customer', invoiceId, params.date, params.amount, entryId)
  return entryId
}

/** The year-2 supplier payment on a linked invoice: buildSupplierInvoicePaymentLines. */
async function paySupplier(
  company: CashCompany,
  supplierInvoiceId: string,
  params: { date: string; amount: number; fiscalPeriodId: string },
): Promise<string> {
  const payment = buildSupplierInvoicePaymentLines(
    { supplier_invoice_number: 'LF-2001', arrival_number: 2001 },
    { paymentAccount: '1930', paymentAmount: params.amount, supplierName: 'Leverantör AB' },
  )
  expect(sig(payment.lines)).toEqual([['1930', 0, params.amount], ['2440', params.amount, 0]])
  const entryId = await post(company, {
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    description: payment.description,
    sourceType: 'supplier_invoice_paid',
    sourceId: supplierInvoiceId,
    lines: payment.lines,
  })
  await insertPaymentRow(company, 'supplier', supplierInvoiceId, params.date, params.amount, entryId)
  return entryId
}

interface CarriedScenario {
  company: CashCompany
  invoiceId: string
  supplierInvoiceId: string
}

/**
 * F and L carried at 2026-12-31, each paid in full in year 2 through the
 * ordinary clearing door on the given dates.
 */
async function seedCarriedScenario(
  payments: { customer: string; supplier: string } = { customer: '2027-02-15', supplier: '2027-02-20' },
): Promise<CarriedScenario> {
  const company = await seedCashCompany()
  const invoiceId = await insertCustomerInvoice(company)
  const supplierInvoiceId = await insertSupplierInvoice(company)

  const c = await carryCustomer(company, invoiceId, customerSource(invoiceId))
  // Pin the shape: 1510 D 1250 / 3001 K 1000 / 2611 K 250 on the ORDINARY
  // output moms account, no 2618, no 29xx.
  expect(sig(c.lines)).toEqual([['1510', 1250, 0], ['2611', 0, 250], ['3001', 0, 1000]])
  const cs = await carrySupplier(company, supplierInvoiceId, supplierSource(supplierInvoiceId))
  expect(sig(cs.lines)).toEqual([['2440', 0, 500], ['2641', 100, 0], ['6110', 400, 0]])

  await payCustomer(company, invoiceId, {
    date: payments.customer, amount: CUSTOMER_TOTAL, fiscalPeriodId: company.nextPeriodId,
  })
  await paySupplier(company, supplierInvoiceId, {
    date: payments.supplier, amount: SUPPLIER_TOTAL, fiscalPeriodId: company.nextPeriodId,
  })
  return { company, invoiceId, supplierInvoiceId }
}

// ---------------------------------------------------------------------------
// Reading the declaration and the ledger
// ---------------------------------------------------------------------------

type Totals = Map<string, { debit: number; credit: number }>

async function declarationTotals(companyId: string, period: Period): Promise<Totals> {
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

async function rutor(companyId: string, period: Period) {
  return rutorFromTotals(await declarationTotals(companyId, period))
}

async function sumOver(companyId: string, periods: Period[], box: Box): Promise<number> {
  let sum = 0
  for (const period of periods) {
    sum = Math.round((sum + (await rutor(companyId, period))[box]) * 100) / 100
  }
  return sum
}

/** Signed (credit - debit) sum of the drill-down lines on `accounts`. */
async function drillDownNet(companyId: string, period: Period, accounts: string[]): Promise<number> {
  const { rows } = await getPool().query<{ debit_amount: string; credit_amount: string }>(
    `SELECT * FROM public.get_vat_ruta_source_lines(
       $1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, period.start, period.end, accounts, P_RUTA_ACCOUNTS, P_NET_ACCOUNTS],
  )
  return Math.round(
    rows.reduce((sum, r) => sum + Number(r.credit_amount) - Number(r.debit_amount), 0) * 100,
  ) / 100
}

/**
 * Signed debit - credit over every booked verifikat up to `end`. A reversed
 * verifikat stays in the ledger next to its storno, so both count.
 */
async function ledgerBalance(companyId: string, account: string, end: string): Promise<number> {
  const { rows } = await getPool().query<{ balance: string | null }>(
    `SELECT sum(l.debit_amount - l.credit_amount) AS balance
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status IN ('posted', 'reversed')
        AND e.entry_date <= $2 AND l.account_number = $3`,
    [companyId, end, account],
  )
  return Math.round(Number(rows[0].balance ?? 0) * 100) / 100
}

/**
 * The momsredovisning verifikat buildVatSettlementProposal() proposes for a
 * period, mirrored line for line: every 26xx account the declaration reads is
 * cleared by its RPC total, the filed net goes to 2650 / 1650. Amounts here
 * are whole kronor, so no 3740 line arises.
 */
async function postSettlement(company: CashCompany, fiscalPeriodId: string, period: Period) {
  const totals = await declarationTotals(company.companyId, period)
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
  await post(company, {
    fiscalPeriodId,
    entryDate: period.end,
    description: `Momsredovisning ${period.start}..${period.end}`,
    sourceType: 'vat_settlement',
    lines,
  })
}

// ---------------------------------------------------------------------------
// Årsomföring: declared once
// ---------------------------------------------------------------------------

describe('kontantmetoden cut-off (årsomföring): an unpaid invoice is declared exactly once', () => {
  it('year 1 final period declares the unpaid invoices (ruta 05, 10, 48)', async () => {
    const { company } = await seedCarriedScenario()
    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta10).toBe(CUSTOMER_VAT)
    expect(q4.ruta05).toBe(CUSTOMER_NET)
    expect(q4.ruta48).toBe(SUPPLIER_VAT)
  })

  it('ruta 10 over every year-2 period is 0 for the invoice already declared at year end', async () => {
    const { company } = await seedCarriedScenario()
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta10')).toBe(0)
  })

  it('ruta 05 over every year-2 period is 0 for the sale already declared at year end', async () => {
    const { company } = await seedCarriedScenario()
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta05')).toBe(0)
  })

  it('ruta 48 over every year-2 period is 0 for the purchase already deducted at year end', async () => {
    const { company } = await seedCarriedScenario()
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta48')).toBe(0)
  })

  it('across both years each moms amount is declared exactly once', async () => {
    const { company } = await seedCarriedScenario()
    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta10 + (await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta10'))).toBe(CUSTOMER_VAT)
    expect(q4.ruta48 + (await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta48'))).toBe(SUPPLIER_VAT)
  })

  it('the ruta 10 drill-down over year 2 nets to 0 as well', async () => {
    const { company } = await seedCarriedScenario()
    let net = 0
    for (const period of YEAR2_QUARTERS) {
      net += await drillDownNet(company.companyId, period, ['2611', '2618'])
    }
    expect(net).toBe(0)
    // And it substantiates the year-end figure in the period that declares it.
    expect(await drillDownNet(company.companyId, YEAR1_FINAL_PERIOD, ['2611', '2618'])).toBe(CUSTOMER_VAT)
  })

  it('after each period is swept to 2650, 2611 and 2641 are back at zero and 2650 owes the net once', async () => {
    const { company } = await seedCarriedScenario()
    await postSettlement(company, company.fiscalPeriodId, YEAR1_FINAL_PERIOD)
    for (const period of YEAR2_QUARTERS) await postSettlement(company, company.nextPeriodId, period)

    expect(await ledgerBalance(company.companyId, '2611', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2641', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2650', '2027-12-31')).toBe(-(CUSTOMER_VAT - SUPPLIER_VAT))
    // The reskontra accounts are cleared by the year-2 payments.
    expect(await ledgerBalance(company.companyId, '1510', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2440', '2027-12-31')).toBe(0)
  })

  // Edge case 3: the invoice is linked from the first year end, so a later
  // year end has nothing to carry (the collector reads only unlinked
  // invoices) and the kundfordran stays on 1510 until it is paid.
  it('an invoice unpaid over two year ends is declared once and cleared when paid in year 3', async () => {
    const company = await seedCashCompany()
    const fy2028 = await insertFiscalPeriod({
      userId: company.userId, companyId: company.companyId,
      name: '2028', periodStart: '2028-01-01', periodEnd: '2028-12-31',
    })
    const invoiceId = await insertCustomerInvoice(company)
    const { carryId } = await carryCustomer(company, invoiceId, customerSource(invoiceId))

    // At the 2027 year end the invoice is still linked to C: nothing new.
    const { rows } = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.invoices WHERE id = $1`, [invoiceId],
    )
    expect(rows[0].journal_entry_id).toBe(carryId)
    expect(await ledgerBalance(company.companyId, '1510', '2027-12-31')).toBe(CUSTOMER_TOTAL)

    await payCustomer(company, invoiceId, { date: '2028-03-01', amount: CUSTOMER_TOTAL, fiscalPeriodId: fy2028 })

    const years = [...quarterly(2026), ...quarterly(2027), ...quarterly(2028)]
    expect(await sumOver(company.companyId, years, 'ruta10')).toBe(CUSTOMER_VAT)
    expect(await sumOver(company.companyId, years, 'ruta05')).toBe(CUSTOMER_NET)
    expect(await sumOver(company.companyId, [...quarterly(2027), ...quarterly(2028)], 'ruta10')).toBe(0)
    expect(await ledgerBalance(company.companyId, '1510', '2028-12-31')).toBe(0)
  })

  // Every cadence reads the same ledger through different date windows. A
  // payment in the last month of year 2 must not reach that month's, that
  // quarter's or that year's declaration.
  describe.each([
    ['monthly', monthly(2026).slice(-1), monthly(2027)],
    ['quarterly', quarterly(2026).slice(-1), quarterly(2027)],
    ['annual', annual(2026), annual(2027)],
  ] as const)('%s filer, paid in December of year 2', (_cadence, finalPeriods, year2Periods) => {
    it('declares the invoices in the final period of year 1 and nothing in any year-2 period', async () => {
      const { company } = await seedCarriedScenario({ customer: '2027-12-10', supplier: '2027-12-15' })
      const final = await rutor(company.companyId, finalPeriods[0]!)
      expect([final.ruta05, final.ruta10, final.ruta48]).toEqual([CUSTOMER_NET, CUSTOMER_VAT, SUPPLIER_VAT])
      for (const period of year2Periods) {
        const r = await rutor(company.companyId, period)
        expect({ period: period.start, ruta05: r.ruta05, ruta10: r.ruta10, ruta48: r.ruta48 })
          .toEqual({ period: period.start, ruta05: 0, ruta10: 0, ruta48: 0 })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Edge case 1: paid after year end, before the cut-off was posted
// ---------------------------------------------------------------------------

// Review of #3440: the nightly update_overdue_supplier_invoices() turns
// every unpaid supplier invoice past its due date 'overdue', and the
// collector read only registered/approved/..., so by the bokslut most open
// supplier invoices were silently left out: the skuld, the cost and the
// ingående moms missing from the closed year (BFL 5 kap 2 §).
describe('kontantmetoden cut-off: every supplier invoice still owed is carried', () => {
  it('reads every owed status of the supplier_invoices CHECK, leaving out only reversed', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'public.supplier_invoices'::regclass
          AND c.conname = 'supplier_invoices_status_check'`,
    )
    const statuses = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    const carried = new Set<string>(KONTANTMETOD_CARRY_SUPPLIER_STATUSES)
    expect(statuses.filter((status) => !carried.has(status))).toEqual(['reversed'])
  })

  it('carries an invoice the overdue job flipped, and deducts its moms once', async () => {
    const company = await seedCashCompany()
    const supplierInvoiceId = await insertSupplierInvoice(company)
    // Past due on the real clock, so the nightly job flips it.
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET invoice_date = LEAST(DATE '2026-11-20', CURRENT_DATE - 30),
              due_date = LEAST(DATE '2026-12-20', CURRENT_DATE - 1)
        WHERE id = $1`,
      [supplierInvoiceId],
    )
    await getPool().query(`SELECT public.update_overdue_supplier_invoices()`)
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.supplier_invoices WHERE id = $1`,
      [supplierInvoiceId],
    )
    expect(rows[0].status).toBe('overdue')
    expect(KONTANTMETOD_CARRY_SUPPLIER_STATUSES).toContain(rows[0].status)

    await carrySupplier(company, supplierInvoiceId, supplierSource(supplierInvoiceId))
    await paySupplier(company, supplierInvoiceId, {
      date: '2027-02-20', amount: SUPPLIER_TOTAL, fiscalPeriodId: company.nextPeriodId,
    })
    expect((await rutor(company.companyId, YEAR1_FINAL_PERIOD)).ruta48).toBe(SUPPLIER_VAT)
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta48')).toBe(0)
  })
})

describe('kontantmetoden cut-off: a payment booked as cash before the cut-off is corrected', () => {
  it('stornoes the cash verifikat and re-books it as a clearing on its own date, so year 2 declares nothing', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const source = customerSource(invoiceId)
    const supplier = supplierSource(supplierInvoiceId)

    // E and E_s: the generated kontantmetod cash verifikat, booked on
    // 2027-01-14 while the cut-off was not yet posted.
    const cash = buildInvoiceCashLines(source, ENTITY, 'Kund AB', '1930')
    expect(sig(cash.lines)).toEqual([['1930', 1250, 0], ['2611', 0, 250], ['3001', 0, 1000]])
    const eId = await post(company, {
      fiscalPeriodId: company.nextPeriodId, entryDate: '2027-01-14', description: cash.description,
      sourceType: 'invoice_cash_payment', sourceId: invoiceId, lines: cash.lines,
    })
    const rowId = await insertPaymentRow(company, 'customer', invoiceId, '2027-01-14', CUSTOMER_TOTAL, eId)

    const supplierCash = buildSupplierInvoiceCashLines(
      supplier.invoice, supplier.items, 'swedish_business', { paymentAccount: '1930', supplierName: 'Leverantör AB' },
    )
    expect(sig(supplierCash.lines)).toEqual([['1930', 0, 500], ['2641', 100, 0], ['6110', 400, 0]])
    const esId = await post(company, {
      fiscalPeriodId: company.nextPeriodId, entryDate: '2027-01-14', description: supplierCash.description,
      sourceType: 'supplier_invoice_cash_payment', sourceId: supplierInvoiceId, lines: supplierCash.lines,
    })
    const supplierRowId = await insertPaymentRow(company, 'supplier', supplierInvoiceId, '2027-01-14', SUPPLIER_TOTAL, esId)

    // Before the cut-off, the moms sits in Q1 2027.
    expect((await rutor(company.companyId, YEAR2_QUARTERS[0]!)).ruta10).toBe(CUSTOMER_VAT)

    // The cut-off posts C and C_s on 2026-12-31 ...
    const c = await carryCustomer(company, invoiceId, source)
    const cs = await carrySupplier(company, supplierInvoiceId, supplier)

    // ... then corrects E and E_s with correctEntry, dated E's own date: the
    // bank leg stays, the revenue or cost and the moms become a clearing of
    // 1510 / 2440 at the carried amount.
    const k = buildPaidBeforePostingCorrectionLines({
      side: 'customer', reference: 'F-1001', cashLines: cash.lines, carryLines: c.lines, paymentAmount: CUSTOMER_TOTAL,
    })
    expect(sig(k)).toEqual([['1510', 0, 1250], ['1930', 1250, 0]])
    const ks = buildPaidBeforePostingCorrectionLines({
      side: 'supplier', reference: 'LF-2001', cashLines: supplierCash.lines, carryLines: cs.lines, paymentAmount: SUPPLIER_TOTAL,
    })
    expect(sig(ks)).toEqual([['1930', 0, 500], ['2440', 500, 0]])
    const customerCorrection = await correctLike(company, eId, k, '2027-01-14', company.nextPeriodId)
    await correctLike(company, esId, ks, '2027-01-14', company.nextPeriodId)

    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect([q4.ruta05, q4.ruta10, q4.ruta48]).toEqual([CUSTOMER_NET, CUSTOMER_VAT, SUPPLIER_VAT])
    const q1 = await rutor(company.companyId, YEAR2_QUARTERS[0]!)
    expect([q1.ruta05, q1.ruta10, q1.ruta48]).toEqual([0, 0, 0])
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta10')).toBe(0)

    expect(await ledgerBalance(company.companyId, '1510', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2440', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '1930', '2027-12-31')).toBe(CUSTOMER_TOTAL - SUPPLIER_TOTAL)

    // E is reversed by its storno, K is the rättelse of E, and the one
    // payment row per invoice stays, settling the invoice in full.
    const { rows: entries } = await getPool().query<{ id: string; status: string; correction_of_id: string | null }>(
      `SELECT id, status, correction_of_id FROM public.journal_entries WHERE id = ANY($1)`,
      [[eId, customerCorrection.correctionId]],
    )
    expect(entries.find((e) => e.id === eId)?.status).toBe('reversed')
    expect(entries.find((e) => e.id === customerCorrection.correctionId)?.correction_of_id).toBe(eId)
    const { rows: payments } = await getPool().query<{ id: string; amount: string }>(
      `SELECT id, amount FROM public.invoice_payments WHERE invoice_id = $1`, [invoiceId],
    )
    expect(payments.map((p) => [p.id, Number(p.amount)])).toEqual([[rowId, CUSTOMER_TOTAL]])
    const { rows: supplierPayments } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`, [supplierInvoiceId],
    )
    expect(supplierPayments.map((p) => p.id)).toEqual([supplierRowId])
  })
})

// ---------------------------------------------------------------------------
// ROT/RUT, reverse charge and a year-2 credit note
// ---------------------------------------------------------------------------

describe('kontantmetoden cut-off: special invoices keep their moms in the closed year', () => {
  it('a ROT invoice is carried in full: customer share on 1510, Skatteverket share on 1513, moms once', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company, { subtotal: 10000, vat: 2500 })
    const source = customerSource(invoiceId, {
      subtotal: 10000, subtotal_sek: 10000, vat_amount: 2500, vat_amount_sek: 2500,
      total: 12500, total_sek: 12500,
      items: [customerItem(invoiceId, {
        unit_price: 10000, line_total: 10000, vat_amount: 2500, deduction_type: 'rot',
      })],
    })
    // The registration shape decides the split; read the deduction from it.
    const probe = buildKontantmetodCarryLines(
      { side: 'customer', invoice: source, reference: 'F-1001', creditNote: false, outstandingOwn: 0, customerShareOwn: 0 },
      ENTITY,
    )
    const deduction = netOn(probe.lines, '1513')
    expect(deduction).toBeGreaterThan(0)
    const share = Math.round((12500 - deduction) * 100) / 100

    const c = await carryCustomer(company, invoiceId, source, { outstanding: share, customerShare: share })
    expect(netOn(c.lines, '1510')).toBe(share)
    expect(netOn(c.lines, '1513')).toBe(deduction)

    // Year 2: the customer pays their share, Skatteverket pays the deduction.
    await payCustomer(company, invoiceId, { date: '2027-02-15', amount: share, fiscalPeriodId: company.nextPeriodId })
    await post(company, {
      fiscalPeriodId: company.nextPeriodId, entryDate: '2027-03-20', description: 'Utbetalning ROT-avdrag F-1001',
      sourceType: 'rot_rut_payout', sourceId: invoiceId,
      lines: [
        { account_number: '1930', debit_amount: deduction, credit_amount: 0 },
        { account_number: '1513', debit_amount: 0, credit_amount: deduction },
      ],
    })

    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta05).toBe(10000)
    expect(q4.ruta10).toBe(2500)
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta05')).toBe(0)
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta10')).toBe(0)
    expect(await ledgerBalance(company.companyId, '1510', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '1513', '2027-12-31')).toBe(0)
  })

  it('a reverse-charge purchase declares its basis and both moms legs at year end, nothing at payment', async () => {
    const company = await seedCashCompany()
    const supplierInvoiceId = await insertSupplierInvoice(company, { subtotal: 1000, vat: 0 })
    const source = supplierSource(
      supplierInvoiceId,
      {
        subtotal: 1000, subtotal_sek: 1000, vat_amount: 0, vat_amount_sek: 0, total: 1000, total_sek: 1000,
        reverse_charge: true, vat_treatment: 'reverse_charge', remaining_amount: 1000,
      },
      [{ account_number: '6540', unit_price: 1000, line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25 }],
    )
    const cs = await carrySupplier(company, supplierInvoiceId, source, 'eu_business')
    expect(netOn(cs.lines, '2440')).toBe(-1000)
    expect(netOn(cs.lines, '2614')).toBe(-250)
    expect(netOn(cs.lines, '2645')).toBe(250)

    await paySupplier(company, supplierInvoiceId, { date: '2027-02-20', amount: 1000, fiscalPeriodId: company.nextPeriodId })

    // EU service purchase: the basis in ruta 21, the computed output moms in
    // ruta 30 and the deduction in ruta 48, all in the closed year.
    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect(q4.ruta21).toBe(1000)
    expect(q4.ruta30).toBe(250)
    expect(q4.ruta48).toBe(250)
    for (const box of ['ruta21', 'ruta30', 'ruta48'] as const) {
      expect(await sumOver(company.companyId, YEAR2_QUARTERS, box)).toBe(0)
    }
    expect(await ledgerBalance(company.companyId, '2440', '2027-12-31')).toBe(0)
  })

  // Edge case 4: a kreditfaktura issued in year 2 against a carried invoice
  // books the accrual credit-note shape (the link makes the invoice an
  // accrual one), so it reduces ruta 05 and 10 in its own period.
  it('a year-2 credit note on a carried invoice reduces ruta 05 and 10 in its own period', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomer(company, invoiceId, customerSource(invoiceId))

    const creditNoteId = await insertCustomerInvoice(company, {
      subtotal: -CUSTOMER_NET, vat: -CUSTOMER_VAT, invoiceDate: '2027-03-10', creditedInvoiceId: invoiceId,
    })
    const creditLines = buildCreditNoteLines(
      customerSource(creditNoteId, {
        invoice_number: 'K-1001', invoice_date: '2027-03-10',
        subtotal: -CUSTOMER_NET, subtotal_sek: -CUSTOMER_NET, vat_amount: -CUSTOMER_VAT, vat_amount_sek: -CUSTOMER_VAT,
        total: -CUSTOMER_TOTAL, total_sek: -CUSTOMER_TOTAL, credited_invoice_id: invoiceId,
        items: [customerItem(creditNoteId, { unit_price: -CUSTOMER_NET, line_total: -CUSTOMER_NET, vat_amount: -CUSTOMER_VAT })],
      }),
      ENTITY,
    )
    expect(sig(creditLines)).toEqual([['1510', 0, 1250], ['2611', 250, 0], ['3001', 1000, 0]])
    await post(company, {
      fiscalPeriodId: company.nextPeriodId, entryDate: '2027-03-10', description: 'Kreditfaktura K-1001',
      sourceType: 'credit_note', sourceId: creditNoteId, lines: creditLines,
    })

    const q1 = await rutor(company.companyId, YEAR2_QUARTERS[0]!)
    expect(q1.ruta05).toBe(-CUSTOMER_NET)
    expect(q1.ruta10).toBe(-CUSTOMER_VAT)
    const both = [YEAR1_FINAL_PERIOD, ...YEAR2_QUARTERS]
    expect(await sumOver(company.companyId, both, 'ruta10')).toBe(0)
    expect(await sumOver(company.companyId, both, 'ruta05')).toBe(0)
    expect(await ledgerBalance(company.companyId, '1510', '2027-12-31')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Legacy: the aggregate cut-off with vändning (self-hosted only)
// ---------------------------------------------------------------------------

async function markLegacy(
  company: CashCompany,
  kind: 'receivable' | 'receivable_reversal' | 'payable' | 'payable_reversal',
  journalEntryId: string,
): Promise<void> {
  // The row the old postKontantmetodCutoff() recorded: fiscal_period_id is the
  // year being CLOSED for all four kinds, the vändningar included. Written as
  // the superuser: an installation that posted these before the fix keeps
  // them (API roles can no longer add a vändning marker).
  await getPool().query(
    `INSERT INTO public.kontantmetod_cutoff_entries
       (company_id, fiscal_period_id, kind, journal_entry_id)
     VALUES ($1, $2, $3, $4)`,
    [company.companyId, company.fiscalPeriodId, kind, journalEntryId],
  )
}

async function seedLegacyScenario(): Promise<CashCompany> {
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
  const company: CashCompany = { userId, companyId, fiscalPeriodId: fy2026, nextPeriodId: fy2027 }

  const cutoff = buildCutoffLines(
    [{
      id: 'cust-inv-1',
      reference: 'F-1001',
      vatTreatment: 'standard_25',
      outstanding: CUSTOMER_TOTAL,
      vat: CUSTOMER_VAT,
    }],
    [{
      id: 'supp-inv-1',
      reference: 'LF-2001',
      outstanding: SUPPLIER_TOTAL,
      vat: SUPPLIER_VAT,
      netByAccount: [{ account: '6110', amount: SUPPLIER_NET }],
    }],
    ENTITY,
  )
  // The legacy shape on the vilande accounts: 1510 D 1250 / 3001 K 1000 /
  // 2618 K 250, 6110 D 400 + 2648 D 100 / 2440 K 500.
  expect(sig(cutoff.receivableLines)).toEqual([['1510', 1250, 0], ['2618', 0, 250], ['3001', 0, 1000]])
  expect(sig(cutoff.payableLines)).toEqual([['2440', 0, 500], ['2648', 100, 0], ['6110', 400, 0]])

  const legacy = [
    { kind: 'receivable', date: '2026-12-31', fp: fy2026, description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivable, lines: cutoff.receivableLines },
    { kind: 'receivable_reversal', date: '2027-01-01', fp: fy2027, description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.receivableReversal, lines: reverseLines(cutoff.receivableLines) },
    { kind: 'payable', date: '2026-12-31', fp: fy2026, description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payable, lines: cutoff.payableLines },
    { kind: 'payable_reversal', date: '2027-01-01', fp: fy2027, description: KONTANTMETOD_CUTOFF_DESCRIPTIONS.payableReversal, lines: reverseLines(cutoff.payableLines) },
  ] as const
  for (const entry of legacy) {
    const id = await post(company, {
      fiscalPeriodId: entry.fp, entryDate: entry.date, description: entry.description,
      sourceType: 'year_end', sourceId: fy2026, lines: entry.lines,
    })
    await markLegacy(company, entry.kind, id)
  }

  // The year-2 payments as the old routing booked them for unlinked
  // invoices: kontantmetod cash verifikat with revenue, cost and moms.
  const customerCash = buildInvoiceCashLines(
    customerSource('00000000-0000-4000-8000-000000001001'), ENTITY, 'Kund AB', '1930',
  )
  await post(company, {
    fiscalPeriodId: fy2027, entryDate: '2027-02-15', description: customerCash.description,
    sourceType: 'invoice_cash_payment', lines: customerCash.lines,
  })
  const supplier = supplierSource('00000000-0000-4000-8000-000000002001')
  const supplierCash = buildSupplierInvoiceCashLines(
    supplier.invoice, supplier.items, 'swedish_business', { paymentAccount: '1930', supplierName: 'Leverantör AB' },
  )
  await post(company, {
    fiscalPeriodId: fy2027, entryDate: '2027-02-20', description: supplierCash.description,
    sourceType: 'supplier_invoice_cash_payment', lines: supplierCash.lines,
  })
  return company
}

describe('legacy vändning shape: the posted verifikat are unchanged by the fix', () => {
  // The fix does not touch the VAT RPCs or the posted verifikat. #3440
  // measured the double declaration on main; the byrå decides on an
  // ändringsdeklaration, and readiness and the VAT check warn
  // LEGACY_KONTANTMETOD_VANDNING ("never storno the vändningar"). Since
  // crm#1562 no ruta reads a vilande account, so the legacy cut-off's moms
  // on 2618/2648 leaves the year-1 rutor: the moms is declared once, by the
  // year-2 payment, and the vilande accounts are never swept to 2650.
  it('keeps the legacy sale in year 1 and declares its moms once, in year 2', async () => {
    const company = await seedLegacyScenario()
    const q4 = await rutor(company.companyId, YEAR1_FINAL_PERIOD)
    expect([q4.ruta05, q4.ruta10, q4.ruta48]).toEqual([CUSTOMER_NET, 0, 0])
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta10')).toBe(CUSTOMER_VAT)
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta05')).toBe(CUSTOMER_NET)
    expect(await sumOver(company.companyId, YEAR2_QUARTERS, 'ruta48')).toBe(SUPPLIER_VAT)

    await postSettlement(company, company.fiscalPeriodId, YEAR1_FINAL_PERIOD)
    for (const period of YEAR2_QUARTERS) await postSettlement(company, company.nextPeriodId, period)
    // The cut-off and its vändning net the vilande accounts to zero.
    expect(await ledgerBalance(company.companyId, '2618', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2648', '2027-12-31')).toBe(0)
    expect(await ledgerBalance(company.companyId, '2650', '2027-12-31')).toBe(-(CUSTOMER_VAT - SUPPLIER_VAT))
  })
})
