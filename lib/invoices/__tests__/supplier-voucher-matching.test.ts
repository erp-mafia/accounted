import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  validateVoucherForSupplierInvoiceLink,
  linkSupplierInvoiceToVoucher,
  findMatchingVouchersForSupplierInvoice,
} from '../supplier-voucher-matching'
import {
  makeSupplierInvoice,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

// Issue #1259: settling the invoice retires the suggestion pointers at it.
// Mocked so it consumes no slot in the queued Supabase mock; the helper's own
// query shape is pinned by ./clear-settled-invoice-suggestions.test.ts.
const { mockClearSuggestions } = vi.hoisted(() => ({ mockClearSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: mockClearSuggestions,
}))

// ============================================================
// validateVoucherForSupplierInvoiceLink: happy path + rejects
// ============================================================

describe('validateVoucherForSupplierInvoiceLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setup(
    invoice = makeSupplierInvoice({ remaining_amount: 1000, total: 1000, currency: 'SEK' }),
  ) {
    return invoice
  }

  it('rejects when the invoice has nothing remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 0,
        paid_amount: 1000,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({ data: null }) // unused, short-circuits before any query
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_FULLY_PAID')
  })

  it('rejects when the voucher is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({ data: null, error: null }) // journal_entries.maybeSingle → null
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-missing',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_VOUCHER_NOT_FOUND')
  })

  it('rejects when the voucher is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'draft',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_NOT_POSTED')
  })

  it('rejects when the voucher has no AP debit on 2440', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    // journal_entries lookup
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    // journal_entry_lines: no 2440 line
    enqueue({
      data: [
        { account_number: '1930', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
        { account_number: '4010', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_NO_AP_DEBIT')
  })

  it('rejects when the AP debit exceeds invoice remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    // 5 000 debit on 2440: overshoots a 1 000 invoice
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 5000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 5000, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
      expect(result.details?.ap_debit).toBe(5000)
      expect(result.details?.remaining).toBe(1000)
    }
  })

  it('accepts an exact-amount match and reports paymentAmount + isFullyPaid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    // existingLinks lookup: none
    enqueue({ data: [], error: null })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.apDebitAmount).toBe(1000)
      expect(result.paymentAmount).toBe(1000)
      expect(result.isFullyPaid).toBe(true)
      expect(result.remainingAfter).toBe(0)
    }
  })

  it('accepts a partial-payment voucher (debit < remaining) and reports partially_paid math', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 400, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
      ],
    })
    enqueue({ data: [], error: null })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(400)
      expect(result.isFullyPaid).toBe(false)
      expect(result.remainingAfter).toBe(600)
    }
  })

  it('rejects currency mismatch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 200,
        paid_amount: 0,
        total: 200,
        currency: 'EUR',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
  })
})

// ============================================================
// linkSupplierInvoiceToVoucher: end-to-end advancement
// ============================================================

describe('linkSupplierInvoiceToVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The implementation now delegates the lock + validate + UPDATE + INSERT
  // sequence to the link_supplier_invoice_to_voucher PL/pgSQL RPC (PR #602
  // review fix). The TS wrapper only translates the RPC's structured jsonb
  // return into the lib's typed Result type and emits the paid event. These
  // tests mock the RPC response directly.

  it('rejects with INVOICE_NOT_FOUND when the RPC reports the invoice is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { ok: false, code: 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND' },
      error: null,
    })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-missing',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_NOT_FOUND')
  })

  it('rejects with INVOICE_FULLY_PAID when the RPC reports the invoice is already paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: false,
        code: 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
        details: { status: 'paid' },
      },
      error: null,
    })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_FULLY_PAID')
      expect(result.details?.status).toBe('paid')
    }
  })

  it('returns LINK_SI_VOUCHER_DB_ERROR when the RPC raises an error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection lost' } })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_DB_ERROR')
      expect(result.details?.reason).toBe('connection lost')
    }
  })

  it('returns success + emits supplier_invoice.paid on the happy path (full payment)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = makeSupplierInvoice({
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
      total: 1000,
      currency: 'SEK',
    })

    // 1. RPC returns the happy path
    enqueue({
      data: {
        ok: true,
        payment_id: 'sip-1',
        invoice_status: 'paid',
        paid_amount: 1000,
        remaining_amount: 0,
        payment_amount: 1000,
        journal_entry_id: 'je-1',
        currency: 'SEK',
      },
      error: null,
    })
    // 2. Lightweight invoice re-fetch for the event payload
    enqueue({ data: invoice, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: invoice.id,
      journalEntryId: 'je-1',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.invoiceStatus).toBe('paid')
      expect(result.result.paidAmount).toBe(1000)
      expect(result.result.remainingAmount).toBe(0)
      expect(result.result.paymentAmount).toBe(1000)
      expect(result.result.journalEntryId).toBe('je-1')
      expect(result.result.paymentId).toBe('sip-1')
    }

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.paid',
        payload: expect.objectContaining({ paymentAmount: 1000, userId: 'user-1' }),
      }),
    )

    // Issue #1259: the invoice is settled, so no transaction may keep pointing
    // at it as a match suggestion.
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1)
    expect(mockClearSuggestions).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'supplier_invoice',
      invoice.id,
    )
  })

  it('still returns success even if the post-link invoice re-fetch is empty (event is best-effort)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        payment_id: 'sip-2',
        invoice_status: 'partially_paid',
        paid_amount: 400,
        remaining_amount: 600,
        payment_amount: 400,
        journal_entry_id: 'je-1',
        currency: 'SEK',
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-2',
      journalEntryId: 'je-1',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.invoiceStatus).toBe('partially_paid')
      expect(result.result.remainingAmount).toBe(600)
    }
    // Event NOT emitted when re-fetch found nothing
    expect(emitSpy).not.toHaveBeenCalled()
    // Issue #1259: a partially paid invoice is still matchable, so the
    // suggestions pointing at it must survive.
    expect(mockClearSuggestions).not.toHaveBeenCalled()
  })
})

// ============================================================
// findMatchingVouchersForSupplierInvoice: candidate search
// ============================================================

describe('findMatchingVouchersForSupplierInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * Enqueue the two pages the two-step entry-lines fetch reads
   * (lib/bookkeeping/entry-lines.ts): the parent entries first, then the bare
   * lines keyed by journal_entry_id. Fixtures stay embed-shaped; the helper
   * reattaches the parent under `journal_entries`, which is exactly what the
   * old `journal_entries!inner(...)` embed produced.
   */
  function enqueueApLines(
    enqueue: (result: { data?: unknown; error?: unknown }) => void,
    rows: Array<{
      id: string
      account_number: string
      debit_amount: number
      currency: string | null
      entry: {
        id: string
        voucher_series: string
        voucher_number: number
        entry_date: string
        description: string
        status: string
        source_type: string | null
        fiscal_period_id: string
      }
    }>,
  ) {
    const entries = [...new Map(rows.map((r) => [r.entry.id, r.entry])).values()]
    enqueue({ data: entries, error: null })
    if (entries.length === 0) return
    enqueue({
      data: rows.map((r) => ({
        id: r.id,
        journal_entry_id: r.entry.id,
        account_number: r.account_number,
        debit_amount: r.debit_amount,
        credit_amount: 0,
        currency: r.currency,
      })),
      error: null,
    })
  }

  /**
   * Record the column list handed to `.select()` per table.
   *
   * The queued mock's proxy chain accepts any column string and still returns
   * the enqueued rows, so a phantom column passes every mocked assertion while
   * PostgREST answers 42703 in production. `fiscal_periods.status` was exactly
   * that: the lock lookup returned null and the advisory flag never fired.
   * Asserting the select string is the only guard available at this layer.
   */
  function recordSelects(supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) {
    const selects: Array<{ table: string; columns: string }> = []
    const inner = supabase.from
    supabase.from = vi.fn((table: string) => {
      const chain = inner(table) as object
      return new Proxy(chain, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop !== 'select') return value
          return (...args: unknown[]) => {
            selects.push({ table, columns: String(args[0] ?? '') })
            return (value as (...a: unknown[]) => unknown)(...args)
          }
        },
      })
    }) as typeof supabase.from
    return selects
  }

  const entryFixture = (over: Partial<{ id: string; description: string; entry_date: string; source_type: string | null }> = {}) => ({
    id: over.id ?? 'je-ap-1',
    voucher_series: 'A',
    voucher_number: 42,
    entry_date: over.entry_date ?? '2026-03-10',
    description: over.description ?? 'Betalning leverantor',
    status: 'posted',
    source_type: over.source_type ?? 'bank_transaction',
    fiscal_period_id: 'period-1',
  })

  const invoice = () =>
    makeSupplierInvoice({
      id: 'si-find-1',
      total: 1000,
      paid_amount: 0,
      remaining_amount: 1000,
      currency: 'SEK',
      due_date: '2026-03-12',
      supplier_invoice_number: 'F-9001',
    })

  it('returns a scored candidate built from the reattached parent entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueApLines(enqueue, [
      {
        id: 'line-1',
        account_number: '2440',
        debit_amount: 1000,
        currency: 'SEK',
        entry: entryFixture({ description: 'Betalning faktura F-9001' }),
      },
    ])
    enqueue({ data: [], error: null }) // supplier_invoice_payments links
    // fiscal_periods: real shape, open period (not closed, never locked)
    enqueue({ data: [{ id: 'period-1', is_closed: false, locked_at: null }], error: null })

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    // The entry side is queried first: no query starts on journal_entry_lines
    // with the tenant scope buried in an embed.
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables[0]).toBe('journal_entries')
    expect(tables[1]).toBe('journal_entry_lines')

    expect(result).toHaveLength(1)
    expect(result[0].journal_entry_id).toBe('je-ap-1')
    expect(result[0].voucher_series).toBe('A')
    expect(result[0].voucher_number).toBe(42)
    expect(result[0].entry_date).toBe('2026-03-10')
    expect(result[0].ap_debit_amount).toBe(1000)
    expect(result[0].ap_line_currency).toBe('SEK')
    expect(result[0].period_locked).toBe(false)
  })

  it('sums several 244x debits on the same samlingsverifikat into one candidate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueApLines(enqueue, [
      { id: 'line-1', account_number: '2440', debit_amount: 600, currency: 'SEK', entry: entryFixture() },
      { id: 'line-2', account_number: '2441', debit_amount: 400, currency: 'SEK', entry: entryFixture() },
    ])
    enqueue({ data: [], error: null })
    enqueue({
      data: [{ id: 'period-1', is_closed: false, locked_at: '2026-04-01T00:00:00Z' }],
      error: null,
    })

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(result).toHaveLength(1)
    expect(result[0].ap_debit_amount).toBe(1000)
    expect(result[0].period_locked).toBe(true)
  })

  it('drops storno and opening_balance vouchers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueApLines(enqueue, [
      {
        id: 'line-1',
        account_number: '2440',
        debit_amount: 1000,
        currency: 'SEK',
        entry: entryFixture({ id: 'je-storno', source_type: 'storno' }),
      },
    ])

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(result).toEqual([])
  })

  it('reads the fiscal_periods columns that actually exist (is_closed, locked_at)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const selects = recordSelects(supabase)
    enqueueApLines(enqueue, [
      {
        id: 'line-1',
        account_number: '2440',
        debit_amount: 1000,
        currency: 'SEK',
        entry: entryFixture(),
      },
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [{ id: 'period-1', is_closed: false, locked_at: null }], error: null })

    await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    const periodSelect = selects.find((s) => s.table === 'fiscal_periods')
    expect(periodSelect).toBeDefined()
    const columns = (periodSelect?.columns ?? '').split(',').map((c) => c.trim())
    expect(columns).toContain('id')
    expect(columns).toContain('is_closed')
    expect(columns).toContain('locked_at')
    // fiscal_periods has no `status` column: asking for it is a 42703.
    expect(columns).not.toContain('status')
  })

  it('flags a candidate whose period is closed (is_closed)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueApLines(enqueue, [
      {
        id: 'line-1',
        account_number: '2440',
        debit_amount: 1000,
        currency: 'SEK',
        entry: entryFixture(),
      },
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [{ id: 'period-1', is_closed: true, locked_at: null }], error: null })

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(result).toHaveLength(1)
    expect(result[0].period_locked).toBe(true)
  })

  it('does not claim the period is open when the lock lookup fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueApLines(enqueue, [
      {
        id: 'line-1',
        account_number: '2440',
        debit_amount: 1000,
        currency: 'SEK',
        entry: entryFixture(),
      },
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: null, error: { message: 'column does not exist' } })

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    // The candidate still surfaces (linking mutates no journal entry), but the
    // advisory flag stays conservative instead of promising an open period.
    expect(result).toHaveLength(1)
    expect(result[0].period_locked).toBe(true)
  })

  it('returns [] without a line query when no entry matches the window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null }) // entry page, empty

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      invoice() as never,
    )

    expect(result).toEqual([])
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('journal_entry_lines')
  })
})
