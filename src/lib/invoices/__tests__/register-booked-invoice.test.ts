import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { buildCreditNoteLines } from '@/lib/bookkeeping/invoice-lines'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { roundOre } from '@/lib/money'
import { resolveOutstandingAsOf } from '@/lib/reports/reskontra-payments'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { VatTreatment } from '@/types'
import { recordInvoicePaymentRow } from '../invoice-payment-row'
import {
  RegisterBookedInvoiceInputSchema,
  RegisterBookedInvoiceParamsSchema,
  deriveInvoiceVatFromVoucher,
  planBookedInvoiceRegistration,
  receivableInCurrency,
  receivableNetDebit,
  registerBookedInvoice,
  toRegisterBookedInvoiceParams,
  type BookedInvoiceVoucherLine,
  type RegisterBookedInvoiceInput,
} from '../register-booked-invoice'
import { REGISTER_BOOKED_INVOICE_MODE, isRegisterBookedInvoiceParams } from '../register-booked-invoice-mode'
import { rateGivingBack } from '../register-booked-rules'
import { DOMESTIC_REVERSE_CHARGE_NOTICE, EU_REVERSE_CHARGE_NOTICE, EXPORT_NOTICE_SV } from '../vat-rules'

// Reminder sending is off product-wide (reminders-enabled.ts). The warning
// must follow that switch, so the tests set it per case.
const reminders = vi.hoisted(() => ({ sendingEnabled: false }))
vi.mock('@/lib/invoices/reminders-enabled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices/reminders-enabled')>()
  return {
    ...actual,
    remindersActiveFor: (setting: boolean | null | undefined) => actual.remindersActiveFor(setting, reminders.sendingEnabled),
  }
})

beforeEach(() => {
  reminders.sendingEnabled = false
})

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'
const VOUCHER_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_INVOICE_ID = '55555555-5555-4555-8555-555555555555'

/** An SIE-imported kundfaktura at 25 %: Dr 1510 12 500 / Cr 3001 10 000 / Cr 2611 2 500. */
const SALE_LINES: BookedInvoiceVoucherLine[] = [
  { account_number: '1510', debit_amount: 12500, credit_amount: 0, currency: 'SEK', line_description: null },
  { account_number: '3001', debit_amount: 0, credit_amount: 10000, currency: 'SEK', line_description: null },
  { account_number: '2611', debit_amount: 0, credit_amount: 2500, currency: 'SEK', line_description: null },
]

/** A zero-rated sale of 12 500 on `revenueAccount`. */
const zeroRatedSale = (revenueAccount: string): BookedInvoiceVoucherLine[] => [
  { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
  { account_number: revenueAccount, debit_amount: 0, credit_amount: 12500 },
]

/** 25 % and 6 % on one invoice: Cr 3001 800 / 2611 200 / 3003 292.45 / 2631 17.55. */
const MIXED_RATE_LINES: BookedInvoiceVoucherLine[] = [
  { account_number: '1510', debit_amount: 1310, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 800 },
  { account_number: '2611', debit_amount: 0, credit_amount: 200 },
  { account_number: '3003', debit_amount: 0, credit_amount: 292.45 },
  { account_number: '2631', debit_amount: 0, credit_amount: 17.55 },
]

/** A taxed and a momsfri part on one invoice: Cr 3001 1 000 / 2611 250 / 3004 500. */
const TAXED_AND_MOMSFRI_LINES: BookedInvoiceVoucherLine[] = [
  { account_number: '1510', debit_amount: 1750, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  { account_number: '2611', debit_amount: 0, credit_amount: 250 },
  { account_number: '3004', debit_amount: 0, credit_amount: 500 },
]

/** A sale of `subtotal` on `revenueAccount` with `vat` on `vatAccount`. */
const taxedSale = (revenueAccount: string, vatAccount: string, subtotal: number, vat: number): BookedInvoiceVoucherLine[] => [
  { account_number: '1510', debit_amount: subtotal + vat, credit_amount: 0 },
  { account_number: revenueAccount, debit_amount: 0, credit_amount: subtotal },
  { account_number: vatAccount, debit_amount: 0, credit_amount: vat },
]

const VOUCHER = {
  id: VOUCHER_ID,
  voucher_series: 'B',
  voucher_number: 45,
  entry_date: '2026-03-02',
  description: 'Kundfaktura 1023 Testkund AB',
  status: 'posted',
  source_type: 'import',
}

const SETTINGS = { invoice_prefix: null, next_invoice_number: 2001, send_invoice_reminders: true, accounting_method: 'accrual' }

function input(overrides: Partial<RegisterBookedInvoiceInput> = {}): RegisterBookedInvoiceInput {
  return {
    mode: REGISTER_BOOKED_INVOICE_MODE,
    customer_id: CUSTOMER_ID,
    invoice_number: '1023',
    invoice_date: '2026-03-02',
    due_date: '2026-04-01',
    journal_entry_id: VOUCHER_ID,
    total: 12500,
    remaining_amount: 12500,
    ...overrides,
  }
}

interface Books {
  customer?: Record<string, unknown> | null
  settings?: Record<string, unknown> | null
  /** invoices by invoice_number. */
  numberRows?: unknown[]
  voucher?: Record<string, unknown> | null
  lines?: BookedInvoiceVoucherLine[]
  /** invoices already pointing at the verifikat. */
  holderRows?: unknown[]
  /** Further invoices answers, in order: the issued-spelling lookup and/or the insert and the rollback. */
  laterInvoices?: TableMockResult[]
  payments?: TableMockResult
}

/** The company's books as the plan reads them (createTableMockSupabase consumes per table, in await order). */
function books(state: Books = {}) {
  return createTableMockSupabase({
    customers: { data: state.customer === undefined ? { id: CUSTOMER_ID, name: 'Testkund AB', email: null } : state.customer },
    company_settings: { data: state.settings === undefined ? SETTINGS : state.settings },
    journal_entries: { data: state.voucher === undefined ? VOUCHER : state.voucher },
    journal_entry_lines: { data: state.lines ?? SALE_LINES },
    invoices: [
      { data: state.numberRows ?? [] },
      { data: state.holderRows ?? [] },
      ...(state.laterInvoices ?? [{ data: { id: 'new-invoice-id' } }]),
    ],
    invoice_payments: state.payments ?? { data: { id: 'payment-row-id' } },
  })
}

const TODAY = '2026-03-10'

describe('deriveInvoiceVatFromVoucher', () => {
  it('reads subtotal, VAT, rate and treatment from a single-rate sale', () => {
    expect(deriveInvoiceVatFromVoucher(SALE_LINES, 12500)).toEqual({
      ok: true,
      vat: { subtotal: 10000, vatAmount: 2500, vatRate: 25, vatTreatment: 'standard_25', momsRuta: '05', reverseChargeText: null },
    })
  })

  it.each<[string, 12 | 6, string, string, number, VatTreatment]>([
    ['12 %', 12, '3002', '2621', 1200, 'reduced_12'],
    ['6 %', 6, '3003', '2631', 600, 'reduced_6'],
  ])('reads a %s sale the same way', (_label, rate, revenueAccount, vatAccount, vat, treatment) => {
    expect(deriveInvoiceVatFromVoucher(taxedSale(revenueAccount, vatAccount, 10000, vat), 10000 + vat)).toEqual({
      ok: true,
      vat: { subtotal: 10000, vatAmount: vat, vatRate: rate, vatTreatment: treatment, momsRuta: '05', reverseChargeText: null },
    })
  })

  it('accepts VAT up to 1 kr off its rate of the rest of the sale, and refuses it beyond', () => {
    // Öresavrundning on 3740: the subtotal read from the header is 1 000.05, whose 25 % is 250.01.
    const roundedTotal: BookedInvoiceVoucherLine[] = [
      { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 999.8 },
      { account_number: '2611', debit_amount: 0, credit_amount: 249.95 },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
    ]
    expect(deriveInvoiceVatFromVoucher(roundedTotal, 1250)).toMatchObject({
      ok: true,
      vat: { subtotal: 1000.05, vatAmount: 249.95, vatTreatment: 'standard_25' },
    })
    expect(deriveInvoiceVatFromVoucher(taxedSale('3001', '2611', 1000, 251), 1251).ok).toBe(true)
    expect(deriveInvoiceVatFromVoucher(taxedSale('3001', '2611', 1000, 251.01), 1251.01)).toEqual({
      ok: false,
      reason: 'vat_not_rate_of_subtotal',
    })
  })

  it.each<[string, VatTreatment, string, string | null]>([
    ['3308', 'reverse_charge', '39', EU_REVERSE_CHARGE_NOTICE],
    ['3305', 'export', '40', EXPORT_NOTICE_SV],
    ['3231', 'reverse_charge_domestic', '41', DOMESTIC_REVERSE_CHARGE_NOTICE],
    ['3004', 'exempt', '', null],
  ])('reads a sale without output VAT on %s as %s', (account, treatment, ruta, notice) => {
    expect(deriveInvoiceVatFromVoucher(zeroRatedSale(account), 12500)).toEqual({
      ok: true,
      vat: { subtotal: 12500, vatAmount: 0, vatRate: 0, vatTreatment: treatment, momsRuta: ruta || null, reverseChargeText: notice },
    })
  })

  it('never counts reverse-charge (x4) or import (x5) output VAT as the sale\'s', () => {
    const lines: BookedInvoiceVoucherLine[] = [
      { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3308', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2614', debit_amount: 0, credit_amount: 250 },
      { account_number: '2645', debit_amount: 250, credit_amount: 0 },
      { account_number: '2615', debit_amount: 0, credit_amount: 40 },
    ]
    const derived = deriveInvoiceVatFromVoucher(lines, 1000)
    expect(derived.ok && derived.vat).toMatchObject({ subtotal: 1000, vatAmount: 0, vatTreatment: 'reverse_charge' })
  })

  it.each<[string, BookedInvoiceVoucherLine[], number, string]>([
    ['VAT at two rates', MIXED_RATE_LINES, 1310, 'mixed_vat_rates'],
    // Registered as standard_25 with subtotal 1 500, its kreditfaktura would
    // take 1 500 out of ruta 05 and leave ruta 42 untouched.
    ['taxed and momsfri revenue (3001, 2611 and 3004)', TAXED_AND_MOMSFRI_LINES, 1750, 'mixed_exempt'],
    [
      // Registered as reverse_charge, its kreditfaktura would put the momsfri
      // 500 into ruta 39 and the periodisk sammanställning.
      'EU services and momsfri revenue (3308 and 3004)',
      [
        { account_number: '1510', debit_amount: 1500, credit_amount: 0 },
        { account_number: '3308', debit_amount: 0, credit_amount: 1000 },
        { account_number: '3004', debit_amount: 0, credit_amount: 500 },
      ],
      1500,
      'mixed_exempt',
    ],
    ['an untaxed part on the taxed account (250 is not 25 % of 1 500)', taxedSale('3001', '2611', 1500, 250), 1750, 'vat_not_rate_of_subtotal'],
    [
      // Begagnad vara sold for 10 000 bought for 6 000: VAT is 20 % of the
      // 4 000 margin, not 25 % of the price.
      'VAT under vinstmarginalbeskattning (2616)',
      [
        { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
        { account_number: '3211', debit_amount: 0, credit_amount: 9200 },
        { account_number: '2616', debit_amount: 0, credit_amount: 800 },
      ],
      10000,
      'margin_scheme_vat',
    ],
    [
      'zero-rated revenue next to output VAT',
      [
        { account_number: '1510', debit_amount: 2250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
        { account_number: '3308', debit_amount: 0, credit_amount: 1000 },
      ],
      2250,
      'zero_rated_with_vat',
    ],
    [
      'two zero-rated treatments',
      [
        { account_number: '1510', debit_amount: 2000, credit_amount: 0 },
        { account_number: '3308', debit_amount: 0, credit_amount: 1000 },
        { account_number: '3305', debit_amount: 0, credit_amount: 1000 },
      ],
      2000,
      'mixed_zero_rated',
    ],
    ['EU goods (3108)', zeroRatedSale('3108'), 12500, 'goods_abroad'],
    ['exported goods (3105)', zeroRatedSale('3105'), 12500, 'goods_abroad'],
    ['trepartshandel (3107)', zeroRatedSale('3107'), 12500, 'goods_abroad'],
    [
      'vilande utgående moms',
      [
        { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
        { account_number: '2618', debit_amount: 0, credit_amount: 2500 },
      ],
      12500,
      'vilande_vat',
    ],
    [
      'negative output VAT',
      [
        { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2611', debit_amount: 100, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1100 },
      ],
      1000,
      'implausible_vat',
    ],
  ])('refuses %s', (_label, lines, total, reason) => {
    expect(deriveInvoiceVatFromVoucher(lines, total)).toEqual({ ok: false, reason })
  })
})

describe('receivableNetDebit', () => {
  it('nets debits and credits on 151x only', () => {
    expect(receivableNetDebit(SALE_LINES)).toBe(12500)
    expect(receivableNetDebit([
      { account_number: '1930', debit_amount: 500, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 500 },
    ])).toBe(-500)
  })
})

describe('RegisterBookedInvoiceInputSchema', () => {
  const valid = {
    customer_id: CUSTOMER_ID,
    invoice_number: ' 1023 ',
    invoice_date: '2026-03-02',
    due_date: '2026-04-01',
    journal_entry_id: VOUCHER_ID,
    total: 12500,
  }
  const issues = (value: Record<string, unknown>) =>
    RegisterBookedInvoiceInputSchema.safeParse(value).error?.issues.map((issue) => issue.path.join('.') || issue.code)

  it('defaults the remaining balance to the total and trims the number', () => {
    const parsed = RegisterBookedInvoiceInputSchema.parse({ ...valid, currency: ' sek ' })
    const params = toRegisterBookedInvoiceParams(parsed)
    expect(params).toMatchObject({ mode: REGISTER_BOOKED_INVOICE_MODE, invoice_number: '1023', remaining_amount: 12500, currency: 'SEK' })
    expect(RegisterBookedInvoiceParamsSchema.safeParse(params).success).toBe(true)
    expect(isRegisterBookedInvoiceParams(params)).toBe(true)
    expect(isRegisterBookedInvoiceParams({ customer_id: CUSTOMER_ID, items: [] })).toBe(false)
  })

  it('refuses a due date before the invoice date, a balance above the total, öre fractions and unknown keys', () => {
    expect(issues({ ...valid, due_date: '2026-03-01' })).toEqual(['due_date'])
    expect(issues({ ...valid, remaining_amount: 12500.01 })).toEqual(['remaining_amount'])
    expect(issues({ ...valid, total: 100.005 })).toEqual(['total'])
    expect(issues({ ...valid, remaining_amount: 0 })).toEqual(['remaining_amount'])
    expect(issues({ ...valid, items: [] })).toEqual(['unrecognized_keys'])
    expect(issues({ ...valid, currency: 'euro' })).toEqual(['currency'])
  })

  it('needs the reskontra date for a partly paid invoice, on or after the invoice date and not in the future', () => {
    const nextYear = `${Number(todayIsoStockholm().slice(0, 4)) + 1}-01-01`
    expect(issues({ ...valid, remaining_amount: 5000 })).toEqual(['balance_as_of'])
    expect(issues({ ...valid, remaining_amount: 5000, balance_as_of: '2026-03-01' })).toEqual(['balance_as_of'])
    expect(issues({ ...valid, remaining_amount: 5000, balance_as_of: nextYear })).toEqual(['balance_as_of'])
    expect(issues({ ...valid, remaining_amount: 5000, balance_as_of: '2026-03-31' })).toBeUndefined()
    // Unpaid: nothing to date.
    expect(issues(valid)).toBeUndefined()
  })
})

describe('planBookedInvoiceRegistration', () => {
  it('plans an unpaid invoice from the verifikat with no warnings when it names the invoice', async () => {
    const { supabase } = books()
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(), { today: TODAY })

    expect(result).toEqual({
      ok: true,
      plan: {
        customerName: 'Testkund AB',
        voucher: { journalEntryId: VOUCHER_ID, label: 'B45', entryDate: '2026-03-02', description: 'Kundfaktura 1023 Testkund AB' },
        status: 'sent',
        // SEK: no rate, and the kronor are the invoice's own amounts.
        currency: 'SEK',
        exchangeRate: null,
        totalSek: 12500,
        subtotalSek: 10000,
        vatAmountSek: 2500,
        total: 12500,
        subtotal: 10000,
        vatAmount: 2500,
        vatRate: 25,
        vatTreatment: 'standard_25',
        momsRuta: '05',
        reverseChargeText: null,
        paidAmount: 0,
        remainingAmount: 12500,
        paidAsOf: null,
        warnings: [],
      },
    })
  })

  it('carries the reskontra balance of a partly paid invoice as paid_amount, dated the reskontra\'s date', async () => {
    const { supabase } = books()
    const result = await planBookedInvoiceRegistration(
      supabase as never, COMPANY_ID, input({ remaining_amount: 5000, balance_as_of: '2026-03-31' }), { today: TODAY },
    )
    expect(result.ok && result.plan).toMatchObject({ status: 'partially_paid', paidAmount: 7500, remainingAmount: 5000, paidAsOf: '2026-03-31' })
  })

  it('says an overdue registered invoice is not reminded by itself, only while reminders are on, product-wide and for the company', async () => {
    const overdue = { today: '2026-05-01' }
    const customer = { id: CUSTOMER_ID, name: 'Testkund AB', email: 'faktura@example.test' }
    const codes = async (state: Books, overrides: Partial<RegisterBookedInvoiceInput> = {}) => {
      const result = await planBookedInvoiceRegistration(books(state).supabase as never, COMPANY_ID, input(overrides), overdue)
      return result.ok ? result.plan.warnings : []
    }

    // Product-wide switch off: no reminder goes out for any invoice, so there is nothing to tell apart.
    expect(await codes({ customer })).toEqual([])

    reminders.sendingEnabled = true
    const warned = await codes({ customer })
    // The ladder follows only invoices sent from here: never one with no delivery history (policy.ts).
    expect(warned.map((w) => w.code)).toEqual(['REGISTER_OVERDUE_NOT_REMINDED'])
    expect(warned[0].message_sv).toContain('får inga påminnelser av sig själv')
    // Due today is on time: nothing to say yet.
    expect(await codes({ customer }, { due_date: overdue.today })).toEqual([])
    expect(warned[0].message_sv).not.toContain('Stäng av')
    // Partly paid is owed too.
    expect((await codes({ customer }, { remaining_amount: 100, balance_as_of: '2026-03-31' })).map((w) => w.code)).toEqual(['REGISTER_OVERDUE_NOT_REMINDED'])
    expect(await codes({ customer, settings: { ...SETTINGS, send_invoice_reminders: false } })).toEqual([])
    expect(await codes({ customer: { ...customer, email: null } })).toEqual([])
  })

  it('warns when the verifikat neither names the invoice number nor sits near the invoice date', async () => {
    const { supabase } = books({ voucher: { ...VOUCHER, description: 'Försäljning', entry_date: '2025-03-02' } })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(), { today: TODAY })
    expect(result.ok && result.plan.warnings.map((w) => w.code)).toEqual(['REGISTER_VOUCHER_TEXT', 'REGISTER_VOUCHER_DATE'])
  })

  it.each<[string, Books, string, Partial<RegisterBookedInvoiceInput>?]>([
    ['a company on kontantmetoden', { settings: { ...SETTINGS, accounting_method: 'cash' } }, 'INVOICE_REGISTER_CASH_METHOD'],
    ['an invoice the reskontra lists in euro', {}, 'INVOICE_REGISTER_FOREIGN_CURRENCY', { currency: 'EUR' }],
    ['an unknown customer', { customer: null }, 'CUSTOMER_NOT_FOUND'],
    ['a number already in the register', { numberRows: [{ id: OTHER_INVOICE_ID }] }, 'INVOICE_REGISTER_NUMBER_TAKEN'],
    ['an unknown verifikat', { voucher: null }, 'INVOICE_REGISTER_VOUCHER_NOT_FOUND'],
    ['a reversed verifikat', { voucher: { ...VOUCHER, status: 'reversed' } }, 'INVOICE_REGISTER_VOUCHER_NOT_POSTED'],
    ['a storno', { voucher: { ...VOUCHER, source_type: 'storno' } }, 'INVOICE_REGISTER_VOUCHER_NOT_SALE'],
    ['a year-end entry', { voucher: { ...VOUCHER, source_type: 'year_end' } }, 'INVOICE_REGISTER_VOUCHER_NOT_SALE'],
    ['a verifikat that books another invoice', { holderRows: [{ id: OTHER_INVOICE_ID, invoice_number: '1022' }] }, 'INVOICE_REGISTER_VOUCHER_TAKEN'],
    [
      'a receivable booked in euro',
      { lines: SALE_LINES.map((line) => (line.account_number === '1510' ? { ...line, currency: 'EUR' } : line)) },
      'INVOICE_REGISTER_FOREIGN_CURRENCY',
    ],
    [
      'a payment verifikat (credits 1510)',
      {
        lines: [
          { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 12500 },
        ],
      },
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
    ],
    [
      'a kontantmetod sale (no 151x line)',
      {
        lines: [
          { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
          { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
        ],
      },
      'INVOICE_REGISTER_VOUCHER_NOT_SALE',
    ],
    [
      'a samlingsverifikat for several invoices',
      { lines: [...SALE_LINES, { account_number: '1510', debit_amount: 625, credit_amount: 0 }, { account_number: '3001', debit_amount: 0, credit_amount: 625 }] },
      'INVOICE_REGISTER_AMOUNT_MISMATCH',
    ],
    [
      'a ROT/RUT invoice (Skatteverket share on 1513)',
      {
        lines: [
          { account_number: '1510', debit_amount: 8500, credit_amount: 0 },
          { account_number: '1513', debit_amount: 4000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
          { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
        ],
      },
      'INVOICE_REGISTER_VOUCHER_UNSUPPORTED',
    ],
    ['an EU goods sale', { lines: zeroRatedSale('3108') }, 'INVOICE_REGISTER_VOUCHER_UNSUPPORTED'],
  ])('refuses %s', async (_label, state, code, overrides = {}) => {
    const { supabase } = books(state)
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(overrides), { today: TODAY })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe(code)
  })

  it('refuses a mixed-rate invoice: a kreditfaktura of it could not reverse each rate\'s VAT', async () => {
    const { supabase } = books({ lines: MIXED_RATE_LINES })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input({ total: 1310, remaining_amount: 1310 }), { today: TODAY })
    expect(!result.ok && result).toMatchObject({ code: 'INVOICE_REGISTER_VOUCHER_UNSUPPORTED', details: { reason: 'mixed_vat_rates' } })
    expect(!result.ok && result.message).toMatch(/B45 books output VAT at more than one rate/)
  })

  it('refuses taxed and momsfri revenue on one verifikat, naming the ruta 42 accounts', async () => {
    const { supabase } = books({ lines: TAXED_AND_MOMSFRI_LINES })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input({ total: 1750, remaining_amount: 1750 }), { today: TODAY })
    expect(!result.ok && result).toMatchObject({ code: 'INVOICE_REGISTER_VOUCHER_UNSUPPORTED', details: { reason: 'mixed_exempt' } })
    expect(!result.ok && result.message).toMatch(/B45 books momsfri revenue \(ruta 42: 3004, 3100, 3404, 3980 or 3994\) next to output VAT/)
  })

  it('names the untaxed part, momsfri revenue and VMB in the registry sentence the approver reads', () => {
    const entry = getErrorEntry('INVOICE_REGISTER_VOUCHER_UNSUPPORTED')
    expect(entry?.message_sv).toMatch(/en del utan moms, momsfri försäljning/)
    expect(entry?.message_sv).toMatch(/vinstmarginalbeskattning/)
    expect(entry?.message_en).toMatch(/an untaxed part, momsfri or zero-rated sales next to VAT/)
    expect(entry?.message_en).toMatch(/vinstmarginalbeskattning \(VMB\)/)
  })

  it('refuses the opening balance: its 1510 sums every receivable and its VAT lines are year-end balances', async () => {
    const ibLines: BookedInvoiceVoucherLine[] = [
      { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 80000, credit_amount: 0 },
      { account_number: '2611', debit_amount: 0, credit_amount: 1800 },
      { account_number: '2081', debit_amount: 0, credit_amount: 25000 },
      { account_number: '2099', debit_amount: 0, credit_amount: 65700 },
    ]
    const { supabase } = books({ voucher: { ...VOUCHER, source_type: 'opening_balance', entry_date: '2026-01-01' }, lines: ibLines })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input({ invoice_date: '2025-12-20', due_date: '2026-01-19' }), { today: TODAY })
    expect(!result.ok && result.code).toBe('INVOICE_REGISTER_OPENING_BALANCE')
    expect(!result.ok && result.message).toMatch(/Import the SIE file of the year the invoice was booked in/)
  })

  it('refuses a number in Accounted\'s own series that the counter has not passed', async () => {
    const { supabase } = books({ settings: { ...SETTINGS, next_invoice_number: 1 } })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(), { today: TODAY })
    expect(!result.ok && result.code).toBe('INVOICE_REGISTER_NUMBER_IN_SERIES')
    expect(!result.ok && result.details).toEqual({ invoice_number: '1023', next_invoice_number: 1, invoice_prefix: null })
  })

  it('lets a number outside the series through whatever the counter says', async () => {
    const { supabase } = books({ settings: { ...SETTINGS, invoice_prefix: 'F', next_invoice_number: 1 } })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(), { today: TODAY })
    expect(result.ok).toBe(true)
  })

  it('treats "12" as the löpnummer Accounted already issued as "012"', async () => {
    const { supabase, findCalls } = books({
      settings: { ...SETTINGS, next_invoice_number: 58 },
      laterInvoices: [{ data: [{ id: OTHER_INVOICE_ID }] }],
    })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input({ invoice_number: '12' }), { today: TODAY })
    expect(!result.ok && result.code).toBe('INVOICE_REGISTER_NUMBER_TAKEN')
    expect(findCalls('invoices', 'eq')).toContainEqual(['invoice_number', '012'])
  })
})

describe('registerBookedInvoice', () => {
  it('writes one invoices row linked to the verifikat and nothing to the journal', async () => {
    const { supabase, calls, findCall } = books()
    const result = await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, input(), { today: TODAY })

    expect(result).toMatchObject({ ok: true, invoiceId: 'new-invoice-id' })
    // SEK: no rate (null, the columns' default), and the kronor columns are the amounts themselves.
    expect(findCall('invoices', 'insert')?.[0]).toEqual({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      invoice_number: '1023',
      invoice_date: '2026-03-02',
      due_date: '2026-04-01',
      status: 'sent',
      document_type: 'invoice',
      currency: 'SEK',
      exchange_rate: null,
      exchange_rate_date: null,
      subtotal: 10000,
      subtotal_sek: 10000,
      vat_amount: 2500,
      vat_amount_sek: 2500,
      total: 12500,
      total_sek: 12500,
      vat_rate: 25,
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
      paid_amount: 0,
      remaining_amount: 12500,
      journal_entry_id: VOUCHER_ID,
    })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert invoices'])
    expect(calls.some((call) => call.table.startsWith('rpc:'))).toBe(false)
  })

  it('dates the part already paid with one payment row on the reskontra\'s date, without a verifikat', async () => {
    const { supabase, calls, findCall } = books()
    const result = await registerBookedInvoice(
      supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 5000, balance_as_of: '2026-03-31' }), { today: TODAY },
    )

    expect(result).toMatchObject({ ok: true, invoiceId: 'new-invoice-id' })
    expect(findCall('invoices', 'insert')?.[0]).toMatchObject({ status: 'partially_paid', paid_amount: 7500, remaining_amount: 5000 })
    expect(findCall('invoice_payments', 'insert')?.[0]).toEqual({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      invoice_id: 'new-invoice-id',
      payment_date: '2026-03-31',
      amount: 7500,
      currency: 'SEK',
      exchange_rate: null,
      journal_entry_id: null,
      transaction_id: null,
      notes: 'Betalt före registreringen enligt kundreskontran per 2026-03-31',
      // Payment provenance (20261012030300): not from the collections provider.
      source: null,
      external_ref: null,
      // Carried over from the old system's kundreskontra (src/lib/links/link-basis.ts).
      link_basis: 'import_carried_over',
      link_evidence: null,
    })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert invoices', 'insert invoice_payments'])
    expect(calls.some((call) => call.table.startsWith('rpc:'))).toBe(false)
  })

  it('undoes the registration when the payment row cannot be written', async () => {
    const { supabase, calls } = books({
      laterInvoices: [{ data: { id: 'new-invoice-id' } }, { data: null }],
      payments: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    await expect(
      registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 5000, balance_as_of: '2026-03-31' }), { today: TODAY }),
    ).rejects.toMatchObject({ code: '57014' })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert invoices', 'insert invoice_payments', 'delete invoices'])
  })

  it('keeps the as-of reskontra right once the rest is paid in Accounted (balansspecifikation for 1510)', async () => {
    const { supabase, findCall } = books()
    await registerBookedInvoice(
      supabase as never, COMPANY_ID, USER_ID, input({ remaining_amount: 5000, balance_as_of: '2026-03-31' }), { today: TODAY },
    )
    const registered = findCall('invoice_payments', 'insert')?.[0] as { amount: number; payment_date: string }

    // The rest arrives later and is recorded by the one payment-row writer.
    const later = createTableMockSupabase({ invoice_payments: { data: { id: 'later-row' } } })
    await recordInvoicePaymentRow(later.supabase as never, {
      userId: USER_ID,
      companyId: COMPANY_ID,
      invoice: { id: 'new-invoice-id', currency: 'SEK', exchange_rate: null, paid_amount: 7500 },
      paymentDate: '2026-05-15',
      newPaidAmount: 12500,
      journalEntryId: 'payment-voucher',
      linkBasis: { basis: 'user_confirmed' },
    })
    const paidLater = later.findCall('invoice_payments', 'insert')?.[0] as { amount: number; payment_date: string }

    const rows = [registered, paidLater]
    const outstandingAt = (asOf: string) =>
      resolveOutstandingAsOf(
        { id: 'new-invoice-id', paid_at: '2026-05-15T00:00:00Z' },
        12500,
        0,
        {
          paidThrough: new Map([['new-invoice-id', rows.filter((row) => row.payment_date <= asOf).reduce((sum, row) => sum + row.amount, 0)]]),
          hasRows: new Set(['new-invoice-id']),
        },
        asOf,
      ).outstanding

    expect(outstandingAt('2026-12-31')).toBe(0)
    expect(outstandingAt('2026-04-30')).toBe(5000)
  })

  it('writes nothing when a rule refuses', async () => {
    const { supabase, calls } = books({ voucher: { ...VOUCHER, status: 'reversed' } })
    const result = await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, input(), { today: TODAY })
    expect(!result.ok && result.code).toBe('INVOICE_REGISTER_VOUCHER_NOT_POSTED')
    expect(calls.filter((call) => call.method === 'insert')).toEqual([])
  })

  it('answers a number taken between the plan and the insert as taken', async () => {
    const { supabase } = books({ laterInvoices: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }] })
    const result = await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, input(), { today: TODAY })
    expect(!result.ok && result.code).toBe('INVOICE_REGISTER_NUMBER_TAKEN')
  })
})

/**
 * #90 (crm#1336): an invoice in another currency registers against a
 * verifikat that books it in that currency. The verifikat is the record for
 * the kronor and for the invoice's own amount; the rate is the one that
 * gives the booked kronor back, never one the caller supplies.
 */
describe('a foreign-currency invoice', () => {
  /** An EU service of 1 000 EUR at 11.4825, as the engine and create_voucher stamp it: 11 482.50 kr on 1510 and 3308. */
  const EUR_SERVICE_LINES: BookedInvoiceVoucherLine[] = [
    { account_number: '1510', debit_amount: 11482.5, credit_amount: 0, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11.4825 },
    { account_number: '3308', debit_amount: 0, credit_amount: 11482.5, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11.4825 },
  ]

  /** 250 USD at 9.50895 with 25 % VAT, every line in dollars: 200 + 50 USD, 1 901.79 + 475.45 kr. */
  const USD_TAXED_LINES: BookedInvoiceVoucherLine[] = [
    { account_number: '1510', debit_amount: 2377.24, credit_amount: 0, currency: 'USD', amount_in_currency: 250, exchange_rate: 9.50895 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1901.79, currency: 'USD', amount_in_currency: 200, exchange_rate: 9.50895 },
    { account_number: '2611', debit_amount: 0, credit_amount: 475.45, currency: 'USD', amount_in_currency: 50, exchange_rate: 9.50895 },
  ]

  const eur = (overrides: Partial<RegisterBookedInvoiceInput> = {}) =>
    input({ currency: 'EUR', total: 1000, remaining_amount: 1000, ...overrides })

  it('reads the rate and the kronor from the verifikat and keeps the invoice\'s own amounts', async () => {
    const { supabase } = books({ lines: EUR_SERVICE_LINES })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, eur(), { today: TODAY })
    expect(result.ok && result.plan).toMatchObject({
      currency: 'EUR',
      exchangeRate: 11.4825,
      total: 1000,
      subtotal: 1000,
      vatAmount: 0,
      totalSek: 11482.5,
      subtotalSek: 11482.5,
      vatAmountSek: 0,
      vatTreatment: 'reverse_charge',
      momsRuta: '39',
      reverseChargeText: EU_REVERSE_CHARGE_NOTICE,
      status: 'sent',
      remainingAmount: 1000,
    })
  })

  it('writes the row a native foreign invoice has: amounts in euro, kronor from the verifikat, the rate dated the verifikat', async () => {
    const { supabase, calls, findCall } = books({ lines: EUR_SERVICE_LINES })
    const result = await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, eur(), { today: TODAY })

    expect(result).toMatchObject({ ok: true, invoiceId: 'new-invoice-id' })
    expect(findCall('invoices', 'insert')?.[0]).toEqual({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      invoice_number: '1023',
      invoice_date: '2026-03-02',
      due_date: '2026-04-01',
      status: 'sent',
      document_type: 'invoice',
      currency: 'EUR',
      exchange_rate: 11.4825,
      exchange_rate_date: VOUCHER.entry_date,
      subtotal: 1000,
      subtotal_sek: 11482.5,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 1000,
      total_sek: 11482.5,
      vat_rate: 0,
      vat_treatment: 'reverse_charge',
      moms_ruta: '39',
      reverse_charge_text: EU_REVERSE_CHARGE_NOTICE,
      paid_amount: 0,
      remaining_amount: 1000,
      journal_entry_id: VOUCHER_ID,
    })
    const writes = calls.filter((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.method))
    expect(writes.map((call) => `${call.method} ${call.table}`)).toEqual(['insert invoices'])
    expect(findCall('journal_entry_lines', 'select')?.[0]).toMatch(/amount_in_currency, exchange_rate/)
  })

  it('keeps the rate the verifikat names when it gives the kronor back, and the VAT its lines carry in dollars', async () => {
    const { supabase } = books({ lines: USD_TAXED_LINES })
    const result = await planBookedInvoiceRegistration(
      supabase as never, COMPANY_ID, input({ currency: 'USD', total: 250, remaining_amount: 250 }), { today: TODAY },
    )
    expect(result.ok && result.plan).toMatchObject({
      currency: 'USD',
      exchangeRate: 9.50895,
      total: 250,
      subtotal: 200,
      vatAmount: 50,
      totalSek: 2377.24,
      subtotalSek: 1901.79,
      vatAmountSek: 475.45,
      vatRate: 25,
      vatTreatment: 'standard_25',
    })
  })

  it('converts the VAT at the rate when only 151x carries the currency, as the engine books it', async () => {
    const lines: BookedInvoiceVoucherLine[] = [
      { account_number: '1510', debit_amount: 1425, credit_amount: 0, currency: 'EUR', amount_in_currency: 125, exchange_rate: 11.4 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1140, currency: 'SEK' },
      { account_number: '2611', debit_amount: 0, credit_amount: 285, currency: 'SEK' },
    ]
    const { supabase } = books({ lines })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, eur({ total: 125, remaining_amount: 125 }), { today: TODAY })
    expect(result.ok && result.plan).toMatchObject({ exchangeRate: 11.4, total: 125, subtotal: 100, vatAmount: 25, subtotalSek: 1140, vatAmountSek: 285 })
  })

  it('refuses a total the verifikat does not carry in that currency, naming both amounts', async () => {
    const { supabase } = books({ lines: EUR_SERVICE_LINES })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, eur({ total: 1100, remaining_amount: 1100 }), { today: TODAY })
    expect(!result.ok && result).toMatchObject({
      code: 'INVOICE_REGISTER_AMOUNT_MISMATCH',
      details: { currency: 'EUR', booked_in_currency: 1000, expected_in_currency: 1100, booked_sek: 11482.5 },
    })
    expect(!result.ok && result.message).toBe('Verifikat B45 debits 151x by 1000 EUR (11482.5 SEK) but the invoice total is 1100 EUR.')
  })

  it.each<[string, BookedInvoiceVoucherLine[], Partial<RegisterBookedInvoiceInput>, Record<string, unknown>]>([
    ['a euro invoice against a verifikat in kronor only', SALE_LINES, { currency: 'EUR' }, { currency: 'EUR', voucher_currency: 'SEK' }],
    ['a dollar invoice against a verifikat in euro', EUR_SERVICE_LINES, { currency: 'USD', total: 1000, remaining_amount: 1000 }, { currency: 'USD', voucher_currency: 'EUR' }],
    ['a kronor invoice against a verifikat in euro', EUR_SERVICE_LINES, { total: 11482.5, remaining_amount: 11482.5 }, { currency: 'EUR' }],
    ['a currency Accounted does not invoice in', EUR_SERVICE_LINES, { currency: 'PLN', total: 1000, remaining_amount: 1000 }, { currency: 'PLN' }],
  ])('refuses %s', async (_label, lines, overrides, details) => {
    const { supabase } = books({ lines })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input(overrides), { today: TODAY })
    expect(!result.ok && result).toMatchObject({ code: 'INVOICE_REGISTER_FOREIGN_CURRENCY', details })
  })

  it('tells the agent which currency to pass when it left the currency out', async () => {
    const { supabase } = books({ lines: EUR_SERVICE_LINES })
    const result = await planBookedInvoiceRegistration(supabase as never, COMPANY_ID, input({ total: 11482.5, remaining_amount: 11482.5 }), { today: TODAY })
    expect(!result.ok && result.message).toMatch(/register it with currency EUR, total and remaining_amount in EUR/)
  })

  it('dates the part already paid in euro, at the invoice\'s rate', async () => {
    const { supabase, findCall } = books({ lines: EUR_SERVICE_LINES })
    const result = await registerBookedInvoice(
      supabase as never, COMPANY_ID, USER_ID, eur({ remaining_amount: 400, balance_as_of: '2026-03-31' }), { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true })
    expect(findCall('invoices', 'insert')?.[0]).toMatchObject({ status: 'partially_paid', paid_amount: 600, remaining_amount: 400, total_sek: 11482.5 })
    expect(findCall('invoice_payments', 'insert')?.[0]).toMatchObject({ amount: 600, currency: 'EUR', exchange_rate: 11.4825, payment_date: '2026-03-31', journal_entry_id: null })
  })

  it('behaves like a native foreign invoice: a euro payment clears 1510 by what the verifikat booked, the rest is kursdifferens', async () => {
    const { supabase, findCall } = books({ lines: USD_TAXED_LINES })
    await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, input({ currency: 'USD', total: 250, remaining_amount: 250 }), { today: TODAY })
    const row = findCall('invoices', 'insert')?.[0] as { currency: string; exchange_rate: number; total: number; total_sek: number }

    // The revaluation and the reskontra value the open amount at the stored rate: the booked kronor.
    expect(roundOre(row.total * row.exchange_rate)).toBe(2377.24)
    const clearing = buildInvoicePaymentClearingLines(
      { amount: 250, amount_sek: null, currency: 'USD', exchange_rate: 9.6 },
      { currency: row.currency, exchange_rate: row.exchange_rate, remaining_amount: 250, total: row.total, paid_amount: 0 },
      'Betalning faktura 1023', undefined, '1930',
    )
    expect(clearing).toMatchObject({ arSek: 2377.24, bankSek: 2400, fxDiffSek: -22.76 })
  })

  it('reverses the booked kronor on its treatment\'s accounts in a kreditfaktura', async () => {
    const { supabase, findCall } = books({ lines: EUR_SERVICE_LINES })
    await registerBookedInvoice(supabase as never, COMPANY_ID, USER_ID, eur(), { today: TODAY })
    const row = findCall('invoices', 'insert')?.[0] as Record<string, number | string | null>
    // What buildCreditNoteFields copies from the original: currency, rate and the negated header.
    const creditNote = {
      id: 'credit-note-id',
      invoice_number: `KR-${row.invoice_number}`,
      currency: row.currency as string,
      exchange_rate: row.exchange_rate as number,
      vat_treatment: row.vat_treatment as VatTreatment,
      delivery_country: null,
      subtotal: -(row.subtotal as number),
      subtotal_sek: -(row.subtotal_sek as number),
      vat_amount: -(row.vat_amount as number),
      vat_amount_sek: -(row.vat_amount_sek as number),
      total: -(row.total as number),
      total_sek: -(row.total_sek as number),
      items: [],
    }
    expect(buildCreditNoteLines(creditNote, 'aktiebolag', 'B45').map((line) => [line.account_number, line.debit_amount, line.credit_amount])).toEqual([
      ['3308', 11482.5, 0],
      ['1510', 0, 11482.5],
    ])
  })

  it('reads the receivable in the currency from the line amounts, with their side from debit and credit', () => {
    expect(receivableInCurrency(EUR_SERVICE_LINES, 'EUR')).toEqual({ amount: 1000, statedRate: 11.4825 })
    // A stored negative figure: the side comes from the debit column.
    expect(receivableInCurrency([{ ...EUR_SERVICE_LINES[0], amount_in_currency: -1000 }], 'EUR')).toEqual({ amount: 1000, statedRate: 11.4825 })
    expect(receivableInCurrency(EUR_SERVICE_LINES, 'USD')).toBeNull()
    expect(receivableInCurrency(SALE_LINES, 'EUR')).toBeNull()
  })
})

describe('rateGivingBack', () => {
  it('keeps a stated rate that gives the booked kronor back', () => {
    expect(rateGivingBack(250, 2377.24, 9.50895)).toBe(9.50895)
  })

  it('takes the shortest rate that gives the kronor back when none is stated, or the stated one does not', () => {
    expect(rateGivingBack(1000, 11482.5)).toBe(11.4825)
    expect(rateGivingBack(250, 2377.24)).toBe(9.50896)
    expect(rateGivingBack(250, 2377.24, 9.6)).toBe(9.50896)
  })

  it('has no rate for kronor that no positive rate below the column ceiling gives', () => {
    expect(rateGivingBack(0.01, 5000)).toBeNull()
    expect(rateGivingBack(100, 0)).toBeNull()
  })
})

/**
 * A registration has no lines, so a kreditfaktura of it takes
 * buildCreditNoteLines' header fallback. The treatment read from the
 * verifikat must send that reversal to the boxes the sale was declared in.
 */
describe('a kreditfaktura of a registered invoice', () => {
  async function creditLinesFor(lines: BookedInvoiceVoucherLine[], total = 12500) {
    const { supabase, findCall } = books({ lines })
    const result = await registerBookedInvoice(
      supabase as never, COMPANY_ID, USER_ID, input({ total, remaining_amount: total }), { today: TODAY },
    )
    expect(result.ok).toBe(true)
    const row = findCall('invoices', 'insert')?.[0] as Record<string, number | string | null>
    // What commitCreditInvoice copies from the original: negated header, no items.
    const creditNote = {
      id: 'credit-note-id',
      invoice_number: `KR-${row.invoice_number}`,
      currency: 'SEK',
      exchange_rate: null,
      vat_treatment: row.vat_treatment as VatTreatment,
      delivery_country: null,
      subtotal: -Math.abs(row.subtotal as number),
      subtotal_sek: -Math.abs(row.subtotal_sek as number),
      vat_amount: -Math.abs(row.vat_amount as number),
      vat_amount_sek: -Math.abs(row.vat_amount_sek as number),
      total: -Math.abs(row.total as number),
      total_sek: -Math.abs(row.total_sek as number),
      items: [],
    }
    return buildCreditNoteLines(creditNote, 'aktiebolag', 'B45').map((line) => [line.account_number, line.debit_amount, line.credit_amount])
  }

  it('reverses a domestic 25 % sale on 3001 and 2611', async () => {
    expect(await creditLinesFor(SALE_LINES)).toEqual([
      ['3001', 10000, 0],
      ['2611', 2500, 0],
      ['1510', 0, 12500],
    ])
  })

  it.each([
    ['12 %', '3002', '2621', 1200],
    ['6 %', '3003', '2631', 600],
  ])('reverses a domestic %s sale on its own rate\'s accounts', async (_label, revenueAccount, vatAccount, vat) => {
    expect(await creditLinesFor(taxedSale(revenueAccount, vatAccount, 10000, vat), 10000 + vat)).toEqual([
      [revenueAccount, 10000, 0],
      [vatAccount, vat, 0],
      ['1510', 0, 10000 + vat],
    ])
  })

  it.each([
    ['an EU service on 3308 (ruta 39), not the momsfri account', '3308'],
    ['an export service on 3305 (ruta 40)', '3305'],
    ['a sale with omvänd betalningsskyldighet on 3231 (ruta 41)', '3231'],
    ['a momsfri sale on 3004 (ruta 42)', '3004'],
  ])('reverses %s', async (_label, account) => {
    expect(await creditLinesFor(zeroRatedSale(account))).toEqual([
      [account, 12500, 0],
      ['1510', 0, 12500],
    ])
  })
})
