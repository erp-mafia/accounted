import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { buildCreditNoteLines } from '@/lib/bookkeeping/invoice-lines'
import { resolveOutstandingAsOf } from '@/lib/reports/reskontra-payments'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { VatTreatment } from '@/types'
import { recordInvoicePaymentRow } from '../invoice-payment-row'
import {
  RegisterBookedInvoiceInputSchema,
  RegisterBookedInvoiceParamsSchema,
  deriveInvoiceVatFromVoucher,
  planBookedInvoiceRegistration,
  receivableNetDebit,
  registerBookedInvoice,
  toRegisterBookedInvoiceParams,
  type BookedInvoiceVoucherLine,
  type RegisterBookedInvoiceInput,
} from '../register-booked-invoice'
import { REGISTER_BOOKED_INVOICE_MODE, isRegisterBookedInvoiceParams } from '../register-booked-invoice-mode'
import { DOMESTIC_REVERSE_CHARGE_NOTICE, EU_REVERSE_CHARGE_NOTICE, EXPORT_NOTICE_SV } from '../vat-rules'

// Automatic reminder sending is off product-wide (reminders-enabled.ts). The
// warning must follow that switch, so the tests set it per case.
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

  it('warns about reminders only while sending is on, product-wide and for the company, and names Utskick', async () => {
    const overdue = { today: '2026-05-01' }
    const customer = { id: CUSTOMER_ID, name: 'Testkund AB', email: 'faktura@example.test' }
    const codes = async (state: Books, overrides: Partial<RegisterBookedInvoiceInput> = {}) => {
      const result = await planBookedInvoiceRegistration(books(state).supabase as never, COMPANY_ID, input(overrides), overdue)
      return result.ok ? result.plan.warnings : []
    }

    // Product-wide switch off (the state today): no reminder goes out, so no promise is made.
    expect(await codes({ customer })).toEqual([])

    reminders.sendingEnabled = true
    const warned = await codes({ customer })
    expect(warned.map((w) => w.code)).toEqual(['REGISTER_OVERDUE_REMINDERS'])
    expect(warned[0].message_sv).toContain('Inställningar, Utskick')
    expect(await codes({ customer, settings: { ...SETTINGS, send_invoice_reminders: false } })).toEqual([])
    expect(await codes({ customer }, { remaining_amount: 100, balance_as_of: '2026-03-31' })).toEqual([])
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
