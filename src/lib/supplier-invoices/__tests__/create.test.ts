/**
 * The dry-run path of createSupplierInvoice: every check runs and the
 * result is the row that would be written, but no ankomstnummer is drawn
 * and nothing is written or booked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeSupplier, type TableMockResolver } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mockRegistrationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries',
  )
  return {
    ...actual,
    createSupplierInvoiceRegistrationEntry: (...args: unknown[]) => mockRegistrationEntry(...args),
  }
})

const mockRegisterExpenseClaim = vi.fn()
// planExpenseClaim stays real: a dry run plans the utlägg verifikat with reads only.
vi.mock('@/lib/expenses/expense-claims-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/expenses/expense-claims-service')>(
    '@/lib/expenses/expense-claims-service',
  )
  return { ...actual, registerExpenseClaim: (...args: unknown[]) => mockRegisterExpenseClaim(...args) }
})

import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '../create'

const { supabase, setTable, reset, calls } = createTableMockSupabase()

const SUPPLIER_ID = '550e8400-e29b-41d4-a716-446655440000'

// An open fiscal year: the registration builder lists periods (findFiscalPeriod,
// .limit), the period-lock check reads one row (.maybeSingle).
const openPeriod = (id: string): TableMockResolver => (chain) =>
  chain.some((c) => c.method === 'limit') ? { data: [{ id }] } : { data: { id, is_closed: false, locked_at: null } }

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

function ctx() {
  return { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log }
}

function body(overrides: Partial<CreateSupplierInvoiceInput> = {}): CreateSupplierInvoiceInput {
  return {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'LF-DRY',
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    items: [{ description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25 }],
    ...overrides,
  } as CreateSupplierInvoiceInput
}

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

function expectNothingWritten() {
  // No RPC at all, so in particular no get_next_arrival_number.
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(calls.filter((c) => WRITE_METHODS.has(c.method))).toEqual([])
  expect(mockRegistrationEntry).not.toHaveBeenCalled()
  expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID }) })
  setTable('fiscal_periods', openPeriod('fp-1'))
  // The arrival number would be 7 if anyone drew it: a dry run must not.
  setTable('rpc:get_next_arrival_number', { data: 7 })
})

describe('createSupplierInvoice dry run', () => {
  it('returns the preview under faktureringsmetoden and writes nothing', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({
      supplier_id: SUPPLIER_ID,
      supplier_invoice_number: 'LF-DRY',
      status: 'registered',
      currency: 'SEK',
      vat_treatment: 'standard_25',
      reverse_charge: false,
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      total_sek: 1250,
      remaining_amount: 1250,
      would_create_registration_journal_entry: true,
    })
    expect(result.preview.items).toHaveLength(1)
    expect(result.preview.items[0]).toMatchObject({ account_number: '4010', line_total: 1000, vat_amount: 250 })
    expectNothingWritten()
  })

  it('would not create a registration verifikat under kontantmetoden', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
    expectNothingWritten()
  })

  // accounted#58: an unreadable settings row used to mean "accrual,
  // VAT-registered", so a kontantmetod company's invoice was booked at
  // registration with ingående moms it may not deduct.
  it('refuses when the accounting method cannot be read, and writes nothing', async () => {
    setTable('company_settings', { data: null, error: { code: '57014', message: 'statement timeout' } })

    const result = await createSupplierInvoice(ctx(), body())

    expect(result).toMatchObject({
      ok: false,
      code: 'SETTINGS_ACCOUNTING_METHOD_UNREADABLE',
      details: { reason: 'read_failed' },
    })
    expectNothingWritten()
  })

  it('refuses when the settings row is missing, and writes nothing', async () => {
    setTable('company_settings', { data: null })

    const result = await createSupplierInvoice(ctx(), body())

    expect(result).toMatchObject({ ok: false, code: 'SETTINGS_ACCOUNTING_METHOD_MISSING' })
    expectNothingWritten()
  })

  it('would not create a registration verifikat when booking is deferred (#967)', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', defer_invoice_booking: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
    expectNothingWritten()
  })

  it('a privately paid invoice would post the utlägg verifikat even under kontantmetoden', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash' } })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })

    const result = await createSupplierInvoice(ctx(), body({ paid_with_private_funds: true }), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({
      status: 'paid',
      paid_with_private_funds: true,
      remaining_amount: 0,
      would_create_registration_journal_entry: true,
    })
    expectNothingWritten()
  })

  // #73: ML 2023:200 7 kap. 26 och 40 §§ put an EU goods acquisition's
  // reverse-charge moms in the invoice's period whatever the method.
  describe('an EU goods acquisition under kontantmetoden', () => {
    const euGoods = (overrides: Partial<CreateSupplierInvoiceInput> = {}) =>
      body({
        reverse_charge: true,
        reverse_charge_kind: 'eu_goods',
        items: [{ description: 'Varor', amount: 1000, account_number: '4010', vat_rate: 0 }],
        ...overrides,
      } as Partial<CreateSupplierInvoiceInput>)

    beforeEach(() => {
      setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID, supplier_type: 'eu_business' }) })
    })

    it('would create the registration verifikat on the invoice date', async () => {
      setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })

      const result = await createSupplierInvoice(ctx(), euGoods(), { dryRun: true })

      if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
      expect(result.preview).toMatchObject({ reverse_charge: true, reverse_charge_kind: 'eu_goods', total: 1000 })
      expect(result.preview.would_create_registration_journal_entry).toBe(true)
      expectNothingWritten()
    })

    it('keeps an EU service purchase for the payment (7 kap. 16 § andra stycket)', async () => {
      setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })

      const result = await createSupplierInvoice(ctx(), euGoods({ reverse_charge_kind: 'eu_services' }), { dryRun: true })

      if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
      expect(result.preview.would_create_registration_journal_entry).toBe(false)
      expectNothingWritten()
    })

    it('refuses an invoice date in a locked period, as it now books there', async () => {
      setTable('company_settings', {
        data: { accounting_method: 'cash', bookkeeping_locked_through: '2024-12-31' },
      })

      const result = await createSupplierInvoice(ctx(), euGoods(), { dryRun: true })

      expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
      expectNothingWritten()
    })

    // #93: 7 kap. 26 § caps the moms period at the one holding the 15th of
    // the month after delivery, so the lock is checked on that date.
    it.each(['cash', 'accrual'])(
      'checks the lock on the 15th of the month after delivery when the invoice is later (%s)',
      async (accountingMethod) => {
        setTable('company_settings', {
          data: { accounting_method: accountingMethod, vat_registered: true, bookkeeping_locked_through: '2024-05-31' },
        })
        // Delivered in April, invoiced in June: the verifikat is dated 15 May, inside the lock.
        const late = await createSupplierInvoice(
          ctx(),
          euGoods({ invoice_date: '2024-06-20', due_date: '2024-07-20', delivery_date: '2024-04-10' }),
          { dryRun: true },
        )
        expect(late).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })

        // Without a delivery date the invoice date is all there is, and it is open.
        const undated = await createSupplierInvoice(
          ctx(),
          euGoods({ invoice_date: '2024-06-20', due_date: '2024-07-20' }),
          { dryRun: true },
        )
        if (!undated.ok || !undated.dryRun) throw new Error('expected a dry-run preview')
        expect(undated.preview.would_create_registration_journal_entry).toBe(true)
        expectNothingWritten()
      },
    )

    it('leaves an EU service on its invoice date whatever the delivery date', async () => {
      setTable('company_settings', {
        data: { accounting_method: 'accrual', vat_registered: true, bookkeeping_locked_through: '2024-05-31' },
      })
      const result = await createSupplierInvoice(
        ctx(),
        euGoods({ reverse_charge_kind: 'eu_services', invoice_date: '2024-06-20', due_date: '2024-07-20', delivery_date: '2024-04-10' }),
        { dryRun: true },
      )
      expect(result.ok).toBe(true)
      expectNothingWritten()
    })
  })

  it('surfaces the same PERIOD_LOCKED refusal a live commit would', async () => {
    setTable('company_settings', {
      data: { accounting_method: 'accrual', bookkeeping_locked_through: '2024-12-31' },
    })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expectNothingWritten()
  })
})

// crm#1367: the VAT per rate as the document has it. SF-CE-202608 rounded
// line by line came to 3 864,12; the document says 3 864,11.
describe('createSupplierInvoice: VAT as the document states it', () => {
  const selfBillLines = [
    { description: 'Flexintäkt', amount: 17564.15, account_number: '4010', vat_rate: 0.25 as const },
    { description: 'Handelsavgift', amount: -2107.7, account_number: '4010', vat_rate: 0.25 as const },
  ]

  beforeEach(() => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })
  })

  it('books the VAT on the summed base per rate and spreads it over the lines', async () => {
    const result = await createSupplierInvoice(ctx(), body({ items: selfBillLines }), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({ subtotal: 15456.45, vat_amount: 3864.11, total: 19320.56 })
    expect(result.preview.items.map((i) => i.vat_amount)).toEqual([4391.04, -526.93])
    expect(result.preview.vat_by_rate).toEqual([{ rate: 0.25, base: 15456.45, vat: 3864.11, source: 'computed' }])
    expectNothingWritten()
  })

  it('books the vat_breakdown the document states when it is within the per-line rounding', async () => {
    const result = await createSupplierInvoice(
      ctx(),
      body({ items: selfBillLines, vat_breakdown: [{ vat_rate: 0.25, vat_amount: 3864.12 }] }),
      { dryRun: true },
    )

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview).toMatchObject({ vat_amount: 3864.12, total: 19320.57 })
    expect(result.preview.vat_by_rate[0]).toMatchObject({ vat: 3864.12, source: 'stated' })
  })

  it('refuses a vat_breakdown further off than a seller\'s rounding, writing nothing', async () => {
    const result = await createSupplierInvoice(
      ctx(),
      body({ items: selfBillLines, vat_breakdown: [{ vat_rate: 0.25, vat_amount: 3870 }] }),
      { dryRun: true },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'VAT_BREAKDOWN_MISMATCH',
      details: { rate: 0.25, stated: 3870, computed: 3864.11, reason: 'outside_tolerance' },
    })
    expectNothingWritten()
  })

  it('keeps a line\'s own vat_amount as given', async () => {
    const result = await createSupplierInvoice(
      ctx(),
      body({
        items: [
          { description: 'Bil', amount: 1000, account_number: '5611', vat_rate: 0.25, vat_amount: 125 },
          { description: 'Material', amount: 9.98, account_number: '4010', vat_rate: 0.25 },
          { description: 'Material', amount: 9.98, account_number: '4010', vat_rate: 0.25 },
        ],
      }),
      { dryRun: true },
    )

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.items.map((i) => i.vat_amount)).toEqual([125, 2.49, 2.5])
    expect(result.preview.vat_amount).toBe(129.99)
  })
})

// Upplupen kostnad (29xx): July-September electricity on an October invoice.
// A month that cannot take its entry refuses the registration before an
// ankomstnummer is drawn, live and dry run alike.
describe('createSupplierInvoice with an upplupen kostnad', () => {
  const accruedBody = () =>
    body({
      invoice_date: '2026-10-05',
      due_date: '2026-11-04',
      items: [
        {
          description: 'El juli-september',
          amount: 3000,
          account_number: '5020',
          vat_rate: 0.25,
          accrual_period_start: '2026-07-01',
          accrual_period_end: '2026-09-30',
          accrual_balance_account: '2990',
        },
      ],
    })

  beforeEach(() => {
    setTable('fiscal_periods', openPeriod('fp-2026'))
  })

  for (const dryRun of [true, false]) {
    it(`refuses a month on or before the company lock date and writes nothing (dryRun=${dryRun})`, async () => {
      setTable('company_settings', {
        data: { accounting_method: 'accrual', vat_registered: true, bookkeeping_locked_through: '2026-08-31' },
      })

      const result = await createSupplierInvoice(ctx(), accruedBody(), { dryRun })

      expect(result).toMatchObject({
        ok: false,
        code: 'SI_CREATE_FAILED',
        error: {
          code: 'SI_ACCRUED_COST_PERIOD_LOCKED',
          blocked: [
            { date: '2026-07-31', reason: 'company_lock_date_covers' },
            { date: '2026-08-31', reason: 'company_lock_date_covers' },
          ],
        },
      })
      expectNothingWritten()
    })
  }

  it('previews the line on 2990 when every month is open', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), accruedBody(), { dryRun: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.items[0]).toMatchObject({
      account_number: '5020',
      accrual_balance_account: '2990',
      accrual_period_start: '2026-07-01',
      accrual_period_end: '2026-09-30',
    })
    expectNothingWritten()
  })

  it('leaves the months to the Bokför step when booking is deferred', async () => {
    setTable('company_settings', {
      data: { accounting_method: 'accrual', defer_invoice_booking: true, bookkeeping_locked_through: '2026-08-31' },
    })

    const result = await createSupplierInvoice(ctx(), accruedBody(), { dryRun: true })

    expect(result.ok).toBe(true)
    expectNothingWritten()
  })
})

// accounted#113: an omitted periodisering account takes the form's suggestion,
// so months before the invoice month book as an upplupen kostnad.
describe('createSupplierInvoice: an omitted periodisering account', () => {
  const omitted = (accountNumber: string, start: string, end: string) =>
    body({
      invoice_date: '2026-10-05',
      due_date: '2026-11-04',
      items: [
        {
          description: 'Period',
          amount: 3000,
          account_number: accountNumber,
          vat_rate: 0.25,
          accrual_period_start: start,
          accrual_period_end: end,
        },
      ],
    })

  beforeEach(() => {
    setTable('fiscal_periods', openPeriod('fp-2026'))
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })
  })

  it('stores 2990 for months before the invoice month, and 2960 for a räntekostnad', async () => {
    const cost = await createSupplierInvoice(ctx(), omitted('5020', '2026-07-01', '2026-09-30'), { dryRun: true })
    if (!cost.ok || !cost.dryRun) throw new Error('expected a dry-run preview')
    expect(cost.preview.items[0]).toMatchObject({ accrual_balance_account: '2990' })

    const interest = await createSupplierInvoice(ctx(), omitted('8410', '2026-07-01', '2026-09-30'), { dryRun: true })
    if (!interest.ok || !interest.dryRun) throw new Error('expected a dry-run preview')
    expect(interest.preview.items[0]).toMatchObject({ accrual_balance_account: '2960' })
  })

  it('keeps the 17xx convention for months from the invoice month on', async () => {
    const result = await createSupplierInvoice(ctx(), omitted('5010', '2026-10-01', '2027-09-30'), { dryRun: true })
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.items[0]).toMatchObject({ accrual_balance_account: '1710' })
  })

  it('refuses an explicit 17xx account for past months before anything is written', async () => {
    const explicit = omitted('5020', '2026-07-01', '2026-09-30')
    explicit.items[0].accrual_balance_account = '1790'
    const result = await createSupplierInvoice(ctx(), explicit, { dryRun: true })
    expect(result).toMatchObject({
      ok: false,
      code: 'SI_CREATE_FAILED',
      error: { code: 'SI_PREPAID_COST_PERIOD_PAST', suggestedAccount: '2990' },
    })
    expectNothingWritten()
  })
})

// accounted#144: a supplier's default dimension bag is the invoice's when the
// request sends none; a bag sent, {} included, overrides it.
describe('createSupplierInvoice: the supplier default dimensions', () => {
  beforeEach(() => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })
    setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID, default_dimensions: { '1': 'FAST01' } }) })
  })

  it('tags the invoice and every line of its verifikat with the default when the request names none', async () => {
    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true })
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.default_dimensions).toEqual({ '1': 'FAST01' })
    const lines = (result.preview.verifikat as { lines: Array<{ account_number: string; dimensions?: Record<string, string> }> }).lines
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.dimensions, line.account_number).toEqual({ '1': 'FAST01' })
  })

  it("keeps a bag the request sends, and {} registers the invoice untagged", async () => {
    const own = await createSupplierInvoice(ctx(), body({ default_dimensions: { '6': 'P001' } }), { dryRun: true })
    if (!own.ok || !own.dryRun) throw new Error('expected a dry-run preview')
    expect(own.preview.default_dimensions).toEqual({ '6': 'P001' })

    const none = await createSupplierInvoice(ctx(), body({ default_dimensions: {} }), { dryRun: true })
    if (!none.ok || !none.dryRun) throw new Error('expected a dry-run preview')
    expect(none.preview.default_dimensions).toEqual({})
    const lines = (none.preview.verifikat as { lines: Array<{ dimensions?: Record<string, string> }> }).lines
    for (const line of lines) expect(line.dimensions ?? {}).toEqual({})
  })

  it("lets a line's own bag win per key over the supplier default", async () => {
    const result = await createSupplierInvoice(
      ctx(),
      body({ items: [{ description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25, dimensions: { '1': 'FAST02', '6': 'P001' } }] }),
      { dryRun: true },
    )
    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    const lines = (result.preview.verifikat as { lines: Array<{ account_number: string; dimensions?: Record<string, string> }> }).lines
    expect(lines.find((l) => l.account_number === '4010')?.dimensions).toEqual({ '1': 'FAST02', '6': 'P001' })
    expect(lines.find((l) => l.account_number === '2440')?.dimensions).toEqual({ '1': 'FAST01' })
  })
})

// crm#1548: a suppliers:register key registers only what posts nothing.
describe('createSupplierInvoice registerOnly (suppliers:register)', () => {
  it('refuses a faktureringsmetoden registration, which posts a verifikat, and writes nothing', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { registerOnly: true })

    expect(result).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      details: { required_scope: 'suppliers:write', reason: 'posts_verifikat' },
    })
    expectNothingWritten()
  })

  it('refuses the dry run the same way, so the preview never promises a write the call refuses', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true, registerOnly: true })

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE' })
    expectNothingWritten()
  })

  it('refuses an EU goods acquisition under kontantmetoden, which books at registration', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })
    setTable('suppliers', { data: makeSupplier({ id: SUPPLIER_ID, supplier_type: 'eu_business' }) })

    const result = await createSupplierInvoice(
      ctx(),
      body({
        reverse_charge: true,
        reverse_charge_kind: 'eu_goods',
        items: [{ description: 'Varor', amount: 1000, account_number: '4010', vat_rate: 0 }],
      } as Partial<CreateSupplierInvoiceInput>),
      { dryRun: true, registerOnly: true },
    )

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE', details: { reason: 'posts_verifikat' } })
    expectNothingWritten()
  })

  it('refuses a privately paid invoice (the utlägg verifikat) before anything is read', async () => {
    const result = await createSupplierInvoice(ctx(), body({ paid_with_private_funds: true }), { registerOnly: true })

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE', details: { reason: 'paid_privately' } })
    expect(calls).toEqual([])
    expectNothingWritten()
  })

  it('refuses a självfaktura, issued with its SF number at registration, before anything is read', async () => {
    const result = await createSupplierInvoice(ctx(), body({ is_self_billed: true }), { registerOnly: true })

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE', details: { reason: 'self_billed' } })
    expect(calls).toEqual([])
    expectNothingWritten()
  })

  it('lets a registration that posts nothing through: kontantmetoden', async () => {
    setTable('company_settings', { data: { accounting_method: 'cash', vat_registered: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true, registerOnly: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
  })

  it('lets a registration that posts nothing through: deferred booking (#967)', async () => {
    setTable('company_settings', { data: { accounting_method: 'accrual', defer_invoice_booking: true } })

    const result = await createSupplierInvoice(ctx(), body(), { dryRun: true, registerOnly: true })

    if (!result.ok || !result.dryRun) throw new Error('expected a dry-run preview')
    expect(result.preview.would_create_registration_journal_entry).toBe(false)
  })
})
