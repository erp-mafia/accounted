import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { eventBus } from '@/lib/events/bus'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { resolveOutstandingAsOf } from '@/lib/reports/reskontra-payments'
import { REGISTER_BOOKED_INVOICE_MODE } from '@/lib/invoices/register-booked-invoice-mode'
import type { CreateJournalEntryInput, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import {
  RegisterBookedSupplierInvoiceInputSchema,
  RegisterBookedSupplierInvoiceParamsSchema,
  payableDimensions,
  payableNetCredit,
  planBookedSupplierInvoiceRegistration,
  registerBookedSupplierInvoice,
  supplierInvoiceRowsFromVoucher,
  toRegisterBookedSupplierInvoiceParams,
  type BookedSupplierInvoiceVoucherLine,
  type RegisterBookedSupplierInvoiceInput,
} from '../register-booked'
import { buildSupplierCreditNoteRow } from '../credit-note'

// The kreditfaktura check below runs the real credit-note generator; only
// the engine's fiscal-period lookup and the posting itself are stubbed.
const engine = vi.hoisted(() => ({ createJournalEntry: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(async () => 'period-1'),
  createJournalEntry: engine.createJournalEntry,
}))
const { buildSupplierInvoicePaymentLines, createSupplierCreditNoteEntry } = await import('@/lib/bookkeeping/supplier-invoice-entries')

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_INVOICE_ID = '55555555-5555-4555-8555-555555555555'

/** An SIE-imported leverantörsfaktura at 25 %: Dr 6110 8 000 / Dr 2641 2 000 / Cr 2440 10 000. */
const PURCHASE_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '6110', debit_amount: 8000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
  { account_number: '2641', debit_amount: 2000, credit_amount: 0, currency: 'SEK', line_description: null, dimensions: {} },
  { account_number: '2440', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null, dimensions: {} },
]

/**
 * Two cost accounts, one of them on two kostnadsställen, VAT at 12 and 25 %
 * on one 2641 line and an öresavrundning upwards on 3740:
 * 4010 1 000 (KS1) + 4010 500 + 6110 800 + 2641 (120 + 325) + 3740 0.40.
 */
const MIXED_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '4010', debit_amount: 1000, credit_amount: 0, line_description: 'Råvaror', dimensions: { '1': 'KS1' } },
  { account_number: '4010', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: {} },
  { account_number: '6110', debit_amount: 800, credit_amount: 0, line_description: 'Kontorsmaterial', dimensions: {} },
  { account_number: '2641', debit_amount: 445, credit_amount: 0, line_description: null, dimensions: {} },
  { account_number: '3740', debit_amount: 0.4, credit_amount: 0, line_description: 'Öresavrundning', dimensions: {} },
  { account_number: '2440', debit_amount: 0, credit_amount: 2745.4, line_description: null, dimensions: {} },
]

/** PURCHASE_LINES on project P1 (SIE dimension 6) throughout, one row also on a kostnadsställe. */
const TAGGED_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '6110', debit_amount: 8000, credit_amount: 0, line_description: null, dimensions: { '1': 'KS1', '6': 'P1' } },
  { account_number: '2641', debit_amount: 2000, credit_amount: 0, line_description: null, dimensions: { '6': 'P1' } },
  { account_number: '2440', debit_amount: 0, credit_amount: 10000, line_description: null, dimensions: { '6': 'P1' } },
]

/** An EU service under omvänd betalningsskyldighet with its basbelopp rows: rutor 21, 30 and 48. */
const EU_SERVICE_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
  { account_number: '4535', debit_amount: 1000, credit_amount: 0 },
  { account_number: '4598', debit_amount: 0, credit_amount: 1000 },
  { account_number: '2645', debit_amount: 250, credit_amount: 0 },
  { account_number: '2614', debit_amount: 0, credit_amount: 250 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
]

/** A byggtjänst under omvänd betalningsskyldighet in Sverige: rutor 24, 30 and 48 (2647). */
const BYGGTJANST_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '4425', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2647', debit_amount: 250, credit_amount: 0 },
  { account_number: '2614', debit_amount: 0, credit_amount: 250 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
]

/** An import with its VAT in the momsdeklaration: rutor 50, 60 and 48. */
const IMPORT_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '4545', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 250, credit_amount: 0 },
  { account_number: '2615', debit_amount: 0, credit_amount: 250 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
]

/** An öresavrundning downwards: a row that nets to a credit. */
const ROUNDED_DOWN_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '6110', debit_amount: 799.6, credit_amount: 0 },
  { account_number: '2641', debit_amount: 199.9, credit_amount: 0 },
  { account_number: '3740', debit_amount: 0, credit_amount: 0.5 },
  { account_number: '2440', debit_amount: 0, credit_amount: 999 },
]

/** A discount on an account of its own, on a project. */
const DISCOUNT_LINES: BookedSupplierInvoiceVoucherLine[] = [
  { account_number: '4010', debit_amount: 1000, credit_amount: 0, dimensions: { '6': 'P1' } },
  { account_number: '4730', debit_amount: 0, credit_amount: 100, dimensions: { '6': 'P1' } },
  { account_number: '2641', debit_amount: 225, credit_amount: 0 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1125 },
]

/** A purchase of `cost` on `account` with `vat` on 2641 and the skuld on `payable`. */
const purchase = (account: string, cost: number, vat: number, payable = '2440'): BookedSupplierInvoiceVoucherLine[] => [
  { account_number: account, debit_amount: cost, credit_amount: 0 },
  ...(vat > 0 ? [{ account_number: '2641', debit_amount: vat, credit_amount: 0 }] : []),
  { account_number: payable, debit_amount: 0, credit_amount: cost + vat },
]

const VOUCHER = {
  id: VOUCHER_ID,
  voucher_series: 'D',
  voucher_number: 45,
  entry_date: '2026-03-02',
  description: 'Leverantörsfaktura 7781 Leverantören AB',
  status: 'posted',
  source_type: 'import',
}

const SETTINGS = { accounting_method: 'accrual', next_arrival_number: 501 }

function input(overrides: Partial<RegisterBookedSupplierInvoiceInput> = {}): RegisterBookedSupplierInvoiceInput {
  return {
    mode: REGISTER_BOOKED_INVOICE_MODE,
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: '7781',
    invoice_date: '2026-03-02',
    due_date: '2026-04-01',
    journal_entry_id: VOUCHER_ID,
    total: 10000,
    remaining_amount: 10000,
    ...overrides,
  }
}

interface Books {
  supplier?: Record<string, unknown> | null
  settings?: Record<string, unknown> | null
  /** supplier_invoices with the supplier's number. */
  numberRows?: unknown[]
  /** supplier_invoices without a number that carry it as payment_reference, on the same date. */
  referenceRows?: unknown[]
  /** supplier_invoices with the arrival number: read only when the input names one. */
  arrivalRows?: unknown[]
  voucher?: Record<string, unknown> | null
  lines?: BookedSupplierInvoiceVoucherLine[]
  /** supplier_invoices already pointing at the verifikat. */
  holderRows?: unknown[]
  /** Further supplier_invoices answers, in order: the insert and the rollback. */
  laterInvoices?: TableMockResult[]
  items?: TableMockResult
  payments?: TableMockResult
}

/** The company's books as the plan reads them (createTableMockSupabase consumes per table, in await order). */
function books(state: Books = {}, withArrivalLookup = false) {
  return createTableMockSupabase({
    suppliers: { data: state.supplier === undefined ? { id: SUPPLIER_ID, name: 'Leverantören AB', archived_at: null } : state.supplier },
    company_settings: { data: state.settings === undefined ? SETTINGS : state.settings },
    journal_entries: { data: state.voucher === undefined ? VOUCHER : state.voucher },
    journal_entry_lines: { data: state.lines ?? PURCHASE_LINES },
    supplier_invoices: [
      { data: state.numberRows ?? [] },
      { data: state.referenceRows ?? [] },
      ...(withArrivalLookup ? [{ data: state.arrivalRows ?? [] }] : []),
      { data: state.holderRows ?? [] },
      ...(state.laterInvoices ?? [{ data: { id: 'new-supplier-invoice', arrival_number: 501 } }]),
    ],
    supplier_invoice_items: state.items ?? { data: null },
    supplier_invoice_payments: state.payments ?? { data: null },
    'rpc:get_next_arrival_number': { data: 501 },
  })
}

const writesOf = (calls: { table: string; method: string }[]) =>
  calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method)).map((call) => `${call.method} ${call.table}`)

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('supplierInvoiceRowsFromVoucher', () => {
  it('takes every line but the skuld as a row, the ingående moms included, and reads net and moms from them', () => {
    expect(supplierInvoiceRowsFromVoucher(PURCHASE_LINES)).toEqual({
      ok: true,
      rows: [
        { account_number: '6110', dimensions: {}, amount: 8000, description: null },
        { account_number: '2641', dimensions: {}, amount: 2000, description: null },
      ],
      subtotal: 8000,
      vatAmount: 2000,
    })
  })

  it('nets per account and dimensions, keeps the first text, and sums moms at several rates', () => {
    const shape = supplierInvoiceRowsFromVoucher(MIXED_LINES)
    expect(shape).toEqual({
      ok: true,
      rows: [
        { account_number: '4010', dimensions: { '1': 'KS1' }, amount: 1000, description: 'Råvaror' },
        { account_number: '4010', dimensions: {}, amount: 500, description: null },
        { account_number: '6110', dimensions: {}, amount: 800, description: 'Kontorsmaterial' },
        { account_number: '2641', dimensions: {}, amount: 445, description: null },
        { account_number: '3740', dimensions: {}, amount: 0.4, description: 'Öresavrundning' },
      ],
      subtotal: 2300.4,
      vatAmount: 445,
    })
  })

  it('nets a discount on the cost account itself into its row', () => {
    const shape = supplierInvoiceRowsFromVoucher([
      { account_number: '6110', debit_amount: 1000, credit_amount: 0 },
      { account_number: '6110', debit_amount: 0, credit_amount: 100 },
      { account_number: '2641', debit_amount: 225, credit_amount: 0 },
      { account_number: '2440', debit_amount: 0, credit_amount: 1125 },
    ])
    expect(shape.ok && shape.rows.map((row) => [row.account_number, row.amount])).toEqual([['6110', 900], ['2641', 225]])
  })

  it.each<[string, BookedSupplierInvoiceVoucherLine[], Array<[string, number]>, number, number]>([
    [
      'an öresavrundning downwards',
      ROUNDED_DOWN_LINES,
      [['6110', 799.6], ['2641', 199.9], ['3740', -0.5]],
      799.1,
      199.9,
    ],
    [
      'a discount on an account of its own',
      DISCOUNT_LINES,
      [['4010', 1000], ['4730', -100], ['2641', 225]],
      900,
      225,
    ],
  ])('takes %s as a row that nets to a credit', (_label, lines, rows, subtotal, vatAmount) => {
    const shape = supplierInvoiceRowsFromVoucher(lines)
    expect(shape.ok && shape.rows.map((row) => [row.account_number, row.amount])).toEqual(rows)
    expect(shape).toMatchObject({ subtotal, vatAmount })
  })

  it.each<[string, BookedSupplierInvoiceVoucherLine[], Array<[string, number]>, number]>([
    [
      'an EU service with its basbelopp rows (rutor 21, 30 and 48)',
      EU_SERVICE_LINES,
      [['6540', 1000], ['4535', 1000], ['4598', -1000], ['2645', 250], ['2614', -250]],
      1000,
    ],
    [
      'a byggtjänst with omvänd betalningsskyldighet in Sverige (ruta 24, 2647)',
      BYGGTJANST_LINES,
      [['4425', 1000], ['2647', 250], ['2614', -250]],
      1000,
    ],
    [
      'an import with its VAT in the momsdeklaration (rutor 50 and 60, deducted on 2641)',
      IMPORT_LINES,
      [['4545', 1000], ['2641', 250], ['2615', -250]],
      1000,
    ],
    [
      'a partly deductible reverse charge (the non-deductible part on the cost account)',
      [
        { account_number: '6540', debit_amount: 1125, credit_amount: 0 },
        { account_number: '2645', debit_amount: 125, credit_amount: 0 },
        { account_number: '2614', debit_amount: 0, credit_amount: 250 },
        { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
      ],
      [['6540', 1125], ['2645', 125], ['2614', -250]],
      1000,
    ],
  ])('takes %s as its rows, the buyer\'s own VAT not counted as the invoice\'s moms', (_label, lines, rows, subtotal) => {
    const shape = supplierInvoiceRowsFromVoucher(lines)
    expect(shape.ok && shape.rows.map((row) => [row.account_number, row.amount])).toEqual(rows)
    expect(shape).toMatchObject({ subtotal, vatAmount: 0 })
  })

  it('counts the moms the supplier charged beside a reverse charge on one verifikat', () => {
    const shape = supplierInvoiceRowsFromVoucher([
      ...EU_SERVICE_LINES.filter((line) => line.account_number !== '2440'),
      { account_number: '4010', debit_amount: 400, credit_amount: 0 },
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      { account_number: '2440', debit_amount: 0, credit_amount: 1500 },
    ])
    expect(shape).toMatchObject({ ok: true, subtotal: 1400, vatAmount: 100 })
  })

  it.each<[string, BookedSupplierInvoiceVoucherLine[], string]>([
    [
      'the VAT settlement account (2650)',
      [
        { account_number: '6110', debit_amount: 800, credit_amount: 0 },
        { account_number: '2650', debit_amount: 200, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
      ],
      '2650',
    ],
    [
      'utgående moms on a sale (2611)',
      [
        { account_number: '6110', debit_amount: 1250, credit_amount: 0 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
        { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
      ],
      '2611',
    ],
  ])('refuses VAT other than ingående moms and the buyer\'s own: %s', (_label, lines, account) => {
    expect(supplierInvoiceRowsFromVoucher(lines)).toEqual({ ok: false, reason: 'other_vat', account })
  })
})

describe('payableNetCredit', () => {
  it('nets credits and debits on 244x only', () => {
    expect(payableNetCredit(PURCHASE_LINES)).toBe(10000)
    expect(payableNetCredit([
      { account_number: '2440', debit_amount: 500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 500 },
    ])).toBe(-500)
  })
})

describe('payableDimensions', () => {
  const rowsOf = (lines: BookedSupplierInvoiceVoucherLine[]) => {
    const shape = supplierInvoiceRowsFromVoucher(lines)
    if (!shape.ok) throw new Error(`refused: ${shape.reason}`)
    return shape.rows
  }

  it('is the skuld\'s bag when every row carries its keys, whatever else a row carries', () => {
    expect(payableDimensions(TAGGED_LINES, rowsOf(TAGGED_LINES))).toEqual({ '6': 'P1' })
  })

  it('is empty for a skuld booked without dimensions', () => {
    expect(payableDimensions(MIXED_LINES, rowsOf(MIXED_LINES))).toEqual({})
  })

  it.each<[string, BookedSupplierInvoiceVoucherLine[]]>([
    ['a row without the skuld\'s dimension', TAGGED_LINES.map((line) => (line.account_number === '2641' ? { ...line, dimensions: {} } : line))],
    [
      'a skuld split over two projects',
      [
        ...TAGGED_LINES.slice(0, 2),
        { account_number: '2440', debit_amount: 0, credit_amount: 6000, dimensions: { '6': 'P1' } },
        { account_number: '2440', debit_amount: 0, credit_amount: 4000, dimensions: { '6': 'P2' } },
      ],
    ],
  ])('is null for %s: the invoice cannot carry it', (_label, lines) => {
    expect(payableDimensions(lines, rowsOf(lines))).toBeNull()
  })
})

describe('RegisterBookedSupplierInvoiceInputSchema', () => {
  const valid = {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: ' 7781 ',
    invoice_date: '2026-03-02',
    due_date: '2026-04-01',
    journal_entry_id: VOUCHER_ID,
    total: 10000,
  }
  const issues = (value: Record<string, unknown>) =>
    RegisterBookedSupplierInvoiceInputSchema.safeParse(value).error?.issues.map((issue) => issue.path.join('.') || issue.code)

  it('defaults the remaining balance to the total, trims the number and stages in register mode', () => {
    const params = toRegisterBookedSupplierInvoiceParams(
      RegisterBookedSupplierInvoiceInputSchema.parse({ ...valid, arrival_number: 412, currency: ' sek ', payment_reference: ' 4711 ' }),
    )
    expect(params).toMatchObject({
      mode: REGISTER_BOOKED_INVOICE_MODE,
      supplier_invoice_number: '7781',
      arrival_number: 412,
      remaining_amount: 10000,
      currency: 'SEK',
      payment_reference: '4711',
    })
    expect(RegisterBookedSupplierInvoiceParamsSchema.safeParse(params).success).toBe(true)
  })

  it('shares the date and amount rules of the kundreskontra registration', () => {
    const nextYear = `${Number(todayIsoStockholm().slice(0, 4)) + 1}-01-01`
    expect(issues({ ...valid, due_date: '2026-03-01' })).toEqual(['due_date'])
    expect(issues({ ...valid, remaining_amount: 10000.01 })).toEqual(['remaining_amount'])
    expect(issues({ ...valid, total: 100.005 })).toEqual(['total'])
    expect(issues({ ...valid, remaining_amount: 5000 })).toEqual(['balance_as_of'])
    expect(issues({ ...valid, remaining_amount: 5000, balance_as_of: nextYear })).toEqual(['balance_as_of'])
    expect(issues({ ...valid, remaining_amount: 5000, balance_as_of: '2026-03-31' })).toBeUndefined()
  })

  it('refuses an ankomstnummer that is not a positive whole number, and unknown keys', () => {
    expect(issues({ ...valid, arrival_number: 0 })).toEqual(['arrival_number'])
    expect(issues({ ...valid, arrival_number: 12.5 })).toEqual(['arrival_number'])
    expect(issues({ ...valid, items: [] })).toEqual(['unrecognized_keys'])
  })
})

describe('planBookedSupplierInvoiceRegistration', () => {
  it('plans an unpaid invoice from the verifikat, its rows the verifikat\'s, with no warnings when it names the invoice', async () => {
    const { supabase } = books()
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input())

    expect(result).toEqual({
      ok: true,
      plan: {
        supplierName: 'Leverantören AB',
        supplierInvoiceNumber: '7781',
        paymentReference: null,
        voucher: { journalEntryId: VOUCHER_ID, label: 'D45', entryDate: '2026-03-02', description: 'Leverantörsfaktura 7781 Leverantören AB' },
        arrivalNumber: null,
        status: 'registered',
        total: 10000,
        subtotal: 8000,
        vatAmount: 2000,
        vatTreatment: 'standard_25',
        rows: [
          { account_number: '6110', dimensions: {}, amount: 8000, description: 'Leverantörsfaktura 7781 Leverantören AB' },
          { account_number: '2641', dimensions: {}, amount: 2000, description: 'Leverantörsfaktura 7781 Leverantören AB' },
        ],
        defaultDimensions: {},
        voucherLines: [
          { account_number: '6110', debit_amount: 8000, credit_amount: 0 },
          { account_number: '2641', debit_amount: 2000, credit_amount: 0 },
          { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
        ],
        paidAmount: 0,
        remainingAmount: 10000,
        paidAsOf: null,
        warnings: [],
      },
    })
  })

  it('carries the reskontra balance of a partly paid invoice as paid_amount, dated the reskontra\'s date', async () => {
    const { supabase } = books()
    const result = await planBookedSupplierInvoiceRegistration(
      supabase as never, COMPANY_ID, input({ remaining_amount: 4000, balance_as_of: '2026-03-31' }),
    )
    expect(result.ok && result.plan).toMatchObject({ status: 'partially_paid', paidAmount: 6000, remainingAmount: 4000, paidAsOf: '2026-03-31' })
  })

  it.each<[string, BookedSupplierInvoiceVoucherLine[], number, string]>([
    ['moms at 12 %', purchase('4010', 1000, 120), 1120, 'reduced_12'],
    ['moms at 6 %', purchase('4010', 1000, 60), 1060, 'reduced_6'],
    ['moms at no one rate (12 and 25 % on one line)', MIXED_LINES, 2745.4, 'standard_25'],
    ['no moms (a momsfri purchase, or moms the company cannot deduct)', purchase('6310', 1000, 0), 1000, 'exempt'],
    // reverse_charge is the label of an invoice Accounted self-assesses (reverse_charge on).
    ['omvänd betalningsskyldighet, the supplier charging no moms', EU_SERVICE_LINES, 1000, 'exempt'],
    ['an import', IMPORT_LINES, 1000, 'exempt'],
  ])('labels %s', async (_label, lines, total, treatment) => {
    const { supabase } = books({ lines })
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ total, remaining_amount: total }))
    expect(result.ok && result.plan.vatTreatment).toBe(treatment)
  })

  it('warns when the verifikat names neither the number nor the ankomstnummer and sits far from the invoice date', async () => {
    const { supabase } = books({ voucher: { ...VOUCHER, description: 'Inköp', entry_date: '2025-03-02' } }, true)
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ arrival_number: 412 }))
    expect(result.ok && result.plan.warnings.map((w) => w.code)).toEqual(['REGISTER_VOUCHER_TEXT', 'REGISTER_VOUCHER_DATE'])
  })

  it('takes a verifikat that names the old ankomstnummer instead of the supplier\'s number as naming the invoice', async () => {
    const { supabase } = books({ voucher: { ...VOUCHER, description: 'Lev.faktura 412 Leverantören AB' } }, true)
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ arrival_number: 412 }))
    expect(result.ok && result.plan).toMatchObject({ arrivalNumber: 412, warnings: [] })
  })

  it('warns when the skuld sits on another 244x account than the 2440 payments and kreditfakturor clear', async () => {
    const { supabase } = books({ lines: purchase('6110', 8000, 2000, '2441') })
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input())
    expect(result.ok && result.plan.warnings).toEqual([
      expect.objectContaining({ code: 'REGISTER_PAYABLE_ACCOUNT', message_sv: expect.stringContaining('2441') }),
    ])
  })

  it('carries the skuld\'s dimensions as the invoice\'s default, and warns when the invoice cannot carry them', async () => {
    const tagged = await planBookedSupplierInvoiceRegistration(books({ lines: TAGGED_LINES }).supabase as never, COMPANY_ID, input())
    expect(tagged.ok && tagged.plan).toMatchObject({ defaultDimensions: { '6': 'P1' }, warnings: [] })

    const lines = TAGGED_LINES.map((line) => (line.account_number === '2641' ? { ...line, dimensions: {} } : line))
    const partly = await planBookedSupplierInvoiceRegistration(books({ lines }).supabase as never, COMPANY_ID, input())
    expect(partly.ok && partly.plan.defaultDimensions).toEqual({})
    expect(partly.ok && partly.plan.warnings).toEqual([
      expect.objectContaining({ code: 'REGISTER_PAYABLE_DIMENSIONS', message_sv: expect.stringContaining('per dimension') }),
    ])
  })

  describe('a number the supplier puts on every invoice (crm#1039)', () => {
    const reused: Books = { numberRows: [{ id: OTHER_INVOICE_ID, invoice_date: '2026-02-02' }] }

    it('registers it on another invoice date as another invoice: no number, the reference as its payment reference', async () => {
      const { supabase, findCall, findCalls } = books(reused)
      const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input())

      expect(result).toMatchObject({ ok: true, plan: { supplierInvoiceNumber: null, paymentReference: '7781' } })
      expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({ supplier_invoice_number: null, payment_reference: '7781' })
      expect(result.ok && result.plan.warnings).toEqual([
        expect.objectContaining({ code: 'REGISTER_NUMBER_AS_PAYMENT_REFERENCE', message_sv: expect.stringContaining('2026-02-02') }),
      ])
      // The same-date check also reads the invoices stored that way.
      expect(findCalls('supplier_invoices', 'is')).toContainEqual(['supplier_invoice_number', null])
      expect(findCalls('supplier_invoices', 'eq')).toEqual(
        expect.arrayContaining([['payment_reference', '7781'], ['invoice_date', '2026-03-02']]),
      )
    })

    it('keeps a payment reference that is the number itself', async () => {
      const { supabase } = books(reused)
      const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ payment_reference: '7781' }))
      expect(result.ok && result.plan).toMatchObject({ supplierInvoiceNumber: null, paymentReference: '7781' })
    })

    it('refuses an invoice with a payment reference of its own: it cannot keep both', async () => {
      const { supabase } = books(reused)
      const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ payment_reference: '47110815' }))
      expect(!result.ok && result).toMatchObject({
        code: 'SI_REGISTER_NUMBER_REUSED',
        details: { supplier_invoice_id: OTHER_INVOICE_ID, invoice_date: '2026-02-02' },
      })
      expect(getErrorEntry('SI_REGISTER_NUMBER_REUSED')?.message_sv).toMatch(/återanvänder/)
    })
  })

  it.each<[string, Books, string, Partial<RegisterBookedSupplierInvoiceInput>?]>([
    ['a company on kontantmetoden', { settings: { ...SETTINGS, accounting_method: 'cash' } }, 'SI_REGISTER_CASH_METHOD'],
    ['an invoice the reskontra lists in euro', {}, 'SI_REGISTER_FOREIGN_CURRENCY', { currency: 'EUR' }],
    ['an unknown supplier', { supplier: null }, 'SUPPLIER_NOT_FOUND'],
    ['an archived supplier', { supplier: { id: SUPPLIER_ID, name: 'Leverantören AB', archived_at: '2026-01-01T00:00:00Z' } }, 'SUPPLIER_NOT_FOUND'],
    [
      'a number of the supplier already in the register on the same date',
      { numberRows: [{ id: OTHER_INVOICE_ID, invoice_date: '2026-03-02' }] },
      'SI_REGISTER_NUMBER_TAKEN',
    ],
    [
      'the same invoice registered before under a reused number (no number, the reference as payment reference)',
      { referenceRows: [{ id: OTHER_INVOICE_ID }] },
      'SI_REGISTER_NUMBER_TAKEN',
    ],
    ['an unknown verifikat', { voucher: null }, 'SI_REGISTER_VOUCHER_NOT_FOUND'],
    ['a reversed verifikat', { voucher: { ...VOUCHER, status: 'reversed' } }, 'SI_REGISTER_VOUCHER_NOT_POSTED'],
    ['the opening balance', { voucher: { ...VOUCHER, source_type: 'opening_balance' } }, 'SI_REGISTER_OPENING_BALANCE'],
    ['a storno', { voucher: { ...VOUCHER, source_type: 'storno' } }, 'SI_REGISTER_VOUCHER_NOT_PURCHASE'],
    ['a year-end entry', { voucher: { ...VOUCHER, source_type: 'year_end' } }, 'SI_REGISTER_VOUCHER_NOT_PURCHASE'],
    [
      'a verifikat that books another supplier invoice',
      { holderRows: [{ id: OTHER_INVOICE_ID, supplier_invoice_number: '7780', arrival_number: 7 }] },
      'SI_REGISTER_VOUCHER_TAKEN',
    ],
    [
      'a skuld booked in euro',
      { lines: PURCHASE_LINES.map((line) => (line.account_number === '2440' ? { ...line, currency: 'EUR' } : line)) },
      'SI_REGISTER_FOREIGN_CURRENCY',
    ],
    [
      'a payment verifikat (debits 2440)',
      { lines: [{ account_number: '2440', debit_amount: 10000, credit_amount: 0 }, { account_number: '1930', debit_amount: 0, credit_amount: 10000 }] },
      'SI_REGISTER_VOUCHER_NOT_PURCHASE',
    ],
    [
      'a kontantmetod purchase (no 244x line)',
      { lines: [{ account_number: '6110', debit_amount: 8000, credit_amount: 0 }, { account_number: '2641', debit_amount: 2000, credit_amount: 0 }, { account_number: '1930', debit_amount: 0, credit_amount: 10000 }] },
      'SI_REGISTER_VOUCHER_NOT_PURCHASE',
    ],
    [
      'a samlingsverifikat for several invoices',
      { lines: [...PURCHASE_LINES, ...purchase('6110', 500, 125)] },
      'SI_REGISTER_AMOUNT_MISMATCH',
    ],
    [
      'a verifikat that books the VAT settlement account',
      {
        lines: [
          { account_number: '6110', debit_amount: 8000, credit_amount: 0 },
          { account_number: '2650', debit_amount: 2000, credit_amount: 0 },
          { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
        ],
      },
      'SI_REGISTER_VOUCHER_UNSUPPORTED',
    ],
  ])('refuses %s', async (_label, state, code, overrides = {}) => {
    const { supabase } = books(state)
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input(overrides))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe(code)
  })

  it('plans a reverse charge from its rows: no moms of the supplier\'s, net the whole total', async () => {
    const { supabase } = books({ lines: EU_SERVICE_LINES })
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ total: 1000, remaining_amount: 1000 }))
    expect(result.ok && result.plan).toMatchObject({
      subtotal: 1000,
      vatAmount: 0,
      vatTreatment: 'exempt',
      rows: [
        expect.objectContaining({ account_number: '6540', amount: 1000 }),
        expect.objectContaining({ account_number: '4535', amount: 1000 }),
        expect.objectContaining({ account_number: '4598', amount: -1000 }),
        expect.objectContaining({ account_number: '2645', amount: 250 }),
        expect.objectContaining({ account_number: '2614', amount: -250 }),
      ],
    })
  })

  it('says which account books VAT it cannot hold', async () => {
    const { supabase } = books({
      lines: [
        { account_number: '6110', debit_amount: 8000, credit_amount: 0 },
        { account_number: '2650', debit_amount: 2000, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
      ],
    })
    const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input())
    expect(!result.ok && result).toMatchObject({ code: 'SI_REGISTER_VOUCHER_UNSUPPORTED', details: { reason: 'other_vat', account: '2650' } })
    expect(!result.ok && result.message).toMatch(/D45 books 2650, VAT other than ingående moms \(264x\) and the buyer's own VAT/)
    expect(getErrorEntry('SI_REGISTER_VOUCHER_UNSUPPORTED')?.message_sv).toMatch(/köparens egen moms vid omvänd betalningsskyldighet eller import/)
  })

  it('stores a reverse charge with reverse_charge off and rows that net to a credit as they are', async () => {
    const { supabase, findCall, findCalls } = books({ lines: EU_SERVICE_LINES })
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ total: 1000, remaining_amount: 1000 }))
    expect(result.ok).toBe(true)
    // The rows carry the buyer's own VAT: the flag on would self-assess it once more on a kreditfaktura.
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({
      reverse_charge: false, vat_treatment: 'exempt', subtotal: 1000, vat_amount: 0, total: 1000,
    })
    const rows = findCalls('supplier_invoice_items', 'insert').map(([row]) => row as { account_number: string; line_total: number })
    expect(rows.map((row) => [row.account_number, row.line_total])).toEqual([
      ['6540', 1000], ['4535', 1000], ['4598', -1000], ['2645', 250], ['2614', -250],
    ])
  })

  describe('the ankomstnummer', () => {
    it('keeps an old number below next_arrival_number, where Accounted\'s own series starts', async () => {
      const { supabase, findCalls } = books({}, true)
      const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ arrival_number: 412 }))
      expect(result.ok && result.plan.arrivalNumber).toBe(412)
      expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['arrival_number', 412])
    })

    it('refuses a number at or past next_arrival_number: it would sit in Accounted\'s own series, which would continue after it', async () => {
      const { supabase } = books({ settings: { ...SETTINGS, next_arrival_number: 1 } }, true)
      const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ arrival_number: 412 }))
      expect(!result.ok && result).toMatchObject({
        code: 'SI_REGISTER_ARRIVAL_NUMBER_IN_SERIES',
        details: { arrival_number: 412, next_arrival_number: 1 },
      })
      expect(!result.ok && result.message).toMatch(/gnubok_update_company_settings/)
      expect(!result.ok && result.message).toMatch(/would sit in that series, which would continue after it/)
      expect(getErrorEntry('SI_REGISTER_ARRIVAL_NUMBER_IN_SERIES')?.message_sv).not.toMatch(/samma nummer/)
    })

    it('refuses a number another supplier invoice has', async () => {
      const { supabase } = books({ arrivalRows: [{ id: OTHER_INVOICE_ID }] }, true)
      const result = await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input({ arrival_number: 412 }))
      expect(!result.ok && result).toMatchObject({ code: 'SI_REGISTER_ARRIVAL_NUMBER_TAKEN', details: { supplier_invoice_id: OTHER_INVOICE_ID } })
    })

    it('does not look one up when the input names none', async () => {
      const { supabase, findCalls } = books()
      await planBookedSupplierInvoiceRegistration(supabase as never, COMPANY_ID, input())
      expect(findCalls('supplier_invoices', 'eq').some(([column]) => column === 'arrival_number')).toBe(false)
    })
  })
})

describe('registerBookedSupplierInvoice', () => {
  it('writes the supplier invoice linked to the verifikat with its rows, draws the next ankomstnummer and posts nothing', async () => {
    const { supabase, calls, findCall, findCalls } = books()
    const registered = vi.fn()
    eventBus.on('supplier_invoice.registered', registered)

    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ payment_reference: '47110815' }))

    expect(result).toMatchObject({ ok: true, supplierInvoiceId: 'new-supplier-invoice', arrivalNumber: 501 })
    expect(findCall('rpc:get_next_arrival_number', 'rpc')?.[0]).toEqual({ p_company_id: COMPANY_ID })
    expect(findCall('supplier_invoices', 'insert')?.[0]).toEqual({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      supplier_id: SUPPLIER_ID,
      arrival_number: 501,
      supplier_invoice_number: '7781',
      invoice_date: '2026-03-02',
      due_date: '2026-04-01',
      received_date: '2026-03-02',
      status: 'registered',
      currency: 'SEK',
      exchange_rate: null,
      exchange_rate_date: null,
      vat_treatment: 'standard_25',
      reverse_charge: false,
      payment_reference: '47110815',
      default_dimensions: {},
      subtotal: 8000,
      subtotal_sek: 8000,
      vat_amount: 2000,
      vat_amount_sek: 2000,
      total: 10000,
      total_sek: 10000,
      paid_amount: 0,
      remaining_amount: 10000,
      registration_journal_entry_id: VOUCHER_ID,
    })
    expect(findCalls('supplier_invoice_items', 'insert').map(([row]) => row)).toEqual([
      expect.objectContaining({ supplier_invoice_id: 'new-supplier-invoice', sort_order: 0, account_number: '6110', line_total: 8000, unit_price: 8000, quantity: 1, vat_rate: 0, vat_amount: 0, dimensions: {} }),
      expect.objectContaining({ supplier_invoice_id: 'new-supplier-invoice', sort_order: 1, account_number: '2641', line_total: 2000, vat_rate: 0, vat_amount: 0 }),
    ])
    expect(writesOf(calls)).toEqual(['insert supplier_invoices', 'insert supplier_invoice_items', 'insert supplier_invoice_items'])
    expect(calls.filter((call) => call.table.startsWith('rpc:')).map((call) => call.table)).toEqual(['rpc:get_next_arrival_number'])
    expect(registered).toHaveBeenCalledTimes(1)
    expect(registered.mock.calls[0][0]).toMatchObject({ companyId: COMPANY_ID, userId: USER_ID, supplierInvoice: { id: 'new-supplier-invoice' } })
  })

  it('keeps an old ankomstnummer instead of drawing one', async () => {
    const { supabase, calls, findCall } = books({}, true)
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ arrival_number: 412 }))
    expect(result).toMatchObject({ ok: true, arrivalNumber: 412 })
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({ arrival_number: 412 })
    expect(calls.some((call) => call.table.startsWith('rpc:'))).toBe(false)
  })

  it('dates the part already paid with one payment row on the reskontra\'s date, without a verifikat', async () => {
    const { supabase, calls, findCall } = books()
    const result = await registerBookedSupplierInvoice(
      supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 4000, balance_as_of: '2026-03-31' }),
    )

    expect(result).toMatchObject({ ok: true, supplierInvoiceId: 'new-supplier-invoice' })
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({ status: 'partially_paid', paid_amount: 6000, remaining_amount: 4000 })
    expect(findCall('supplier_invoice_payments', 'insert')?.[0]).toEqual({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      supplier_invoice_id: 'new-supplier-invoice',
      payment_date: '2026-03-31',
      amount: 6000,
      currency: 'SEK',
      exchange_rate_difference: 0,
      journal_entry_id: null,
      notes: 'Betalt före registreringen enligt leverantörsreskontran per 2026-03-31',
      link_basis: 'import_carried_over',
      link_evidence: null,
    })
    expect(writesOf(calls)).toEqual([
      'insert supplier_invoices',
      'insert supplier_invoice_items',
      'insert supplier_invoice_items',
      'insert supplier_invoice_payments',
    ])
  })

  it('keeps the as-of leverantörsreskontra right once the rest is paid in Accounted', async () => {
    const { supabase, findCall } = books()
    await registerBookedSupplierInvoice(
      supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 4000, balance_as_of: '2026-03-31' }),
    )
    const before = findCall('supplier_invoice_payments', 'insert')?.[0] as { amount: number; payment_date: string }
    // The rest is paid later, as every payment path records it: a row of its own.
    const rows = [before, { amount: 4000, payment_date: '2026-05-15' }]
    const outstandingAt = (asOf: string) =>
      resolveOutstandingAsOf(
        { id: 'new-supplier-invoice', paid_at: '2026-05-15T12:00:00.000Z' },
        10000,
        0,
        {
          paidThrough: new Map([['new-supplier-invoice', rows.filter((row) => row.payment_date <= asOf).reduce((sum, row) => sum + row.amount, 0)]]),
          hasRows: new Set(['new-supplier-invoice']),
        },
        asOf,
      ).outstanding

    expect(outstandingAt('2026-03-15')).toBe(10000)
    expect(outstandingAt('2026-04-30')).toBe(4000)
    expect(outstandingAt('2026-12-31')).toBe(0)
  })

  it.each<[string, Books]>([
    ['the rows', { items: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } }],
    ['the payment row', { payments: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } }],
  ])('undoes the registration when %s cannot be written', async (_label, state) => {
    const { supabase, calls } = books({
      ...state,
      laterInvoices: [{ data: { id: 'new-supplier-invoice', arrival_number: 501 } }, { data: null }],
    })
    const registered = vi.fn()
    eventBus.on('supplier_invoice.registered', registered)
    await expect(
      registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 4000, balance_as_of: '2026-03-31' })),
    ).rejects.toMatchObject({ code: '57014' })
    expect(writesOf(calls).at(-1)).toBe('delete supplier_invoices')
    expect(registered).not.toHaveBeenCalled()
  })

  it('writes nothing when a rule refuses', async () => {
    const { supabase, calls } = books({ voucher: { ...VOUCHER, status: 'reversed' } })
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input())
    expect(!result.ok && result.code).toBe('SI_REGISTER_VOUCHER_NOT_POSTED')
    expect(writesOf(calls)).toEqual([])
    expect(calls.some((call) => call.table.startsWith('rpc:'))).toBe(false)
  })

  it('answers a number taken between the plan and the insert as taken', async () => {
    const { supabase } = books({
      laterInvoices: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"' } }],
    })
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input())
    expect(!result.ok && result.code).toBe('SI_REGISTER_NUMBER_TAKEN')
  })

  it('answers an old ankomstnummer taken between the plan and the insert as taken', async () => {
    const { supabase } = books({
      laterInvoices: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_supplier_invoices_company_arrival_number"' } }],
    }, true)
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ arrival_number: 412 }))
    expect(!result.ok && result.code).toBe('SI_REGISTER_ARRIVAL_NUMBER_TAKEN')
  })
})

/**
 * A kreditfaktura of a supplier invoice books each of its rows on the other
 * side and debits 2440 by their sum under the invoice's default_dimensions
 * (createSupplierCreditNoteEntry). With the verifikat's own rows and the
 * skuld's dimensions that is the verifikat turned around: every account,
 * dimension and momsruta returns to where the registration found it, a row
 * that nets to a credit and the buyer's own VAT included.
 */
describe('a kreditfaktura of a registered supplier invoice', () => {
  async function creditLinesFor(lines: BookedSupplierInvoiceVoucherLine[], total: number) {
    const { supabase, findCall, findCalls } = books({ lines })
    const result = await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input({ total, remaining_amount: total }))
    expect(result.ok).toBe(true)
    const header = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    const rows = findCalls('supplier_invoice_items', 'insert').map(([row]) => row as Record<string, unknown>)

    // What creditSupplierInvoice writes from the original: its header, its rows.
    const creditNote = {
      ...buildSupplierCreditNoteRow(
        { ...(header as unknown as SupplierInvoice), id: 'new-supplier-invoice' },
        { userId: USER_ID, companyId: COMPANY_ID, arrivalNumber: 502, date: '2026-04-10' },
      ),
      id: 'credit-note',
    } as unknown as SupplierInvoice
    engine.createJournalEntry.mockImplementation(async (_s: unknown, _c: string, _u: string, entry: CreateJournalEntryInput) => ({ id: 'credit-entry', ...entry }))
    await createSupplierCreditNoteEntry(
      null as never,
      COMPANY_ID,
      USER_ID,
      creditNote,
      rows.map((row, index) => ({ ...row, id: `row-${index}` })) as unknown as SupplierInvoiceItem[],
      'swedish_business',
      'Leverantören AB',
      // The payable creditSupplierInvoice holds the reversal to.
      header.total_sek as number,
    )
    return (engine.createJournalEntry.mock.calls[0][3] as CreateJournalEntryInput).lines
  }

  /** Net debit per account and dimensions bag. */
  function netByCell(lines: Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null; dimensions?: Record<string, string> | null }>) {
    const cells = new Map<string, number>()
    for (const line of lines) {
      const bag = JSON.stringify(Object.entries(line.dimensions ?? {}).sort())
      const key = `${line.account_number} ${bag}`
      const net = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      cells.set(key, roundOre((cells.get(key) ?? 0) + net))
    }
    return cells
  }

  it.each<[string, BookedSupplierInvoiceVoucherLine[], number]>([
    ['a domestic 25 % purchase', PURCHASE_LINES, 10000],
    ['rows on two kostnadsställen, moms at two rates and an öresavrundning upwards', MIXED_LINES, 2745.4],
    ['a purchase without moms', purchase('6310', 1000, 0), 1000],
    ['a purchase on a project throughout, the skuld included', TAGGED_LINES, 10000],
    ['an öresavrundning downwards', ROUNDED_DOWN_LINES, 999],
    ['a discount on an account of its own, on a project', DISCOUNT_LINES, 1125],
    ['an EU service under omvänd betalningsskyldighet (rutor 21, 30 and 48)', EU_SERVICE_LINES, 1000],
    ['a byggtjänst under omvänd betalningsskyldighet (rutor 24, 30 and 48)', BYGGTJANST_LINES, 1000],
    ['an import (rutor 50, 60 and 48)', IMPORT_LINES, 1000],
  ])('reverses %s cell by cell', async (_label, lines, total) => {
    const credit = netByCell(await creditLinesFor(lines, total))
    const booked = netByCell(lines)
    expect(credit.size).toBe(booked.size)
    for (const [cell, net] of booked) expect(credit.get(cell), cell).toBe(-net)
  })

  it('lets a payment in Accounted clear 2440 in the cell the verifikat credited', async () => {
    const { supabase, findCall } = books({ lines: TAGGED_LINES })
    await registerBookedSupplierInvoice(supabase as never, COMPANY_ID, USER_ID, input())
    const header = findCall('supplier_invoices', 'insert')?.[0] as SupplierInvoice
    const { lines } = buildSupplierInvoicePaymentLines(header, { paymentAmount: 10000 })
    expect(lines.find((line) => line.account_number === '2440')).toMatchObject({ debit_amount: 10000, dimensions: { '6': 'P1' } })
  })
})
