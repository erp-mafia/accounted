/**
 * When accounting_method may change (lib/company/accounting-method-change.ts):
 * never while an open invoice lacks its own verifikat (#93: on every switch),
 * else free while the current fiscal year has no posted verifikat, afterwards
 * only as a stated correction (PH 187, crm#1303).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const serviceInsert = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: serviceInsert }) }),
}))

import {
  ACCOUNTING_METHOD_MID_YEAR_GUARD,
  checkAccountingMethodChange,
  recordAccountingMethodCorrection,
} from '../accounting-method-change'
import { createTableMockSupabase } from '@/tests/helpers'

type Tables = Parameters<typeof createTableMockSupabase>[0]

/** The shared per-table mock; `calls` records every (table, method, args). */
function makeClient(byTable: Tables) {
  const mock = createTableMockSupabase(byTable)
  return { calls: mock.calls, from: mock.supabase.from, supabase: mock.supabase }
}

const PERIOD = { data: { id: 'fp-2026', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' } }
const ctxFor = (client: ReturnType<typeof makeClient>) => ({ supabase: client.supabase as never, companyId: 'c1' })

describe('checkAccountingMethodChange', () => {
  it('is free when the method does not change, without reading anything', async () => {
    const client = makeClient({})
    for (const [stored, requested] of [['accrual', 'accrual'], [null, 'accrual'], ['cash', undefined], ['cash', null]] as const) {
      const check = await checkAccountingMethodChange(ctxFor(client), { stored, requested, reason: undefined })
      expect(check).toEqual({ kind: 'free' })
    }
    expect(client.from).not.toHaveBeenCalled()
  })

  const NO_OPEN = { invoices: { data: null, count: 0 }, supplier_invoices: { data: null, count: 0 } }

  it('is free while the current fiscal year has no posted verifikat (the onboarding fix)', async () => {
    const client = makeClient({ fiscal_periods: PERIOD, journal_entries: { data: null, count: 0 }, ...NO_OPEN })
    const check = await checkAccountingMethodChange(ctxFor(client), { stored: 'accrual', requested: 'cash', reason: undefined })
    expect(check).toEqual({ kind: 'free' })
  })

  it('is free when no fiscal year covers today', async () => {
    const client = makeClient({ fiscal_periods: { data: null }, ...NO_OPEN })
    expect(await checkAccountingMethodChange(ctxFor(client), { stored: 'accrual', requested: 'cash', reason: undefined }))
      .toEqual({ kind: 'free' })
    expect(client.from).not.toHaveBeenCalledWith('journal_entries')
  })

  // #93: the guard asked only before a correction, so a year with nothing posted
  // let an open invoice without a verifikat through: booked twice after a
  // switch to kontantmetoden, never after one to faktureringsmetoden.
  it.each([
    ['accrual', 'cash'],
    ['cash', 'accrual'],
  ])('refuses a switch from %s to %s with nothing posted while an open invoice has no verifikat', async (stored, requested) => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: { data: null, count: 0 },
      invoices: { data: null, count: 1 },
      supplier_invoices: { data: null, count: 0 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), { stored, requested, reason: undefined })
    expect(check.kind).toBe('refused')
    if (check.kind !== 'refused') return
    expect(check.outcome).toMatchObject({
      code: 'ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES',
      details: { fiscal_period_id: 'fp-2026', open_invoices_without_verifikat: 1, open_supplier_invoices_without_verifikat: 0 },
    })
    expect(check.outcome.messageSv).toContain('kan inte bytas nu')
    // Refused before the year's verifikat are even counted.
    expect(client.from).not.toHaveBeenCalledWith('journal_entries')
  })

  it('refuses a switch with no fiscal year at all while an open supplier invoice has no verifikat', async () => {
    const client = makeClient({
      fiscal_periods: { data: null },
      invoices: { data: null, count: 0 },
      supplier_invoices: { data: null, count: 2 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), { stored: 'cash', requested: 'accrual', reason: undefined })
    expect(check).toMatchObject({
      kind: 'refused',
      outcome: {
        code: 'ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES',
        details: { fiscal_period_id: null, fiscal_year: null, open_supplier_invoices_without_verifikat: 2 },
      },
    })
  })

  it('refuses a mid-year change without a reason, and says how to correct', async () => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: { data: null, count: 112 },
      invoices: { data: null, count: 0 },
      supplier_invoices: { data: null, count: 0 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), { stored: 'accrual', requested: 'cash', reason: '   ' })
    expect(check.kind).toBe('refused')
    if (check.kind !== 'refused') return
    expect(check.outcome.code).toBe('ACCOUNTING_METHOD_CHANGE_MID_YEAR')
    expect(check.outcome.details).toMatchObject({
      fiscal_period_id: 'fp-2026',
      posted_entries: 112,
      correctable_with: 'accounting_method_correction_reason',
    })
  })

  it('refuses a correction while an open invoice has no verifikat of its own, reason or not', async () => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: { data: null, count: 40 },
      invoices: { data: null, count: 2 },
      supplier_invoices: { data: null, count: 1 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), {
      stored: 'cash',
      requested: 'accrual',
      reason: 'Fel metod valdes vid inflyttningen',
    })
    expect(check.kind).toBe('refused')
    if (check.kind !== 'refused') return
    expect(check.outcome.code).toBe('ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES')
    expect(check.outcome.details).toMatchObject({
      open_invoices_without_verifikat: 2,
      open_supplier_invoices_without_verifikat: 1,
    })
    // The open rows are the ones a switch treats differently: open, issued,
    // not a credit note, no verifikat of their own.
    const filters = client.calls.filter((c) => c.table === 'invoices').map((c) => [c.method, ...c.args])
    expect(filters).toEqual(expect.arrayContaining([
      ['eq', 'document_type', 'invoice'],
      ['in', 'status', ['sent', 'overdue', 'partially_paid']],
      ['is', 'journal_entry_id', null],
      ['is', 'credited_invoice_id', null],
    ]))
    const supplierFilters = client.calls.filter((c) => c.table === 'supplier_invoices').map((c) => [c.method, ...c.args])
    expect(supplierFilters).toEqual(expect.arrayContaining([
      ['eq', 'is_credit_note', false],
      ['in', 'status', ['registered', 'approved', 'overdue', 'disputed', 'partially_paid']],
      ['is', 'registration_journal_entry_id', null],
    ]))
  })

  it('allows a stated correction and names the invoice-flow verifikat the year keeps for review', async () => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: [
        { data: null, count: 112 },
        { data: [{ voucher_series: 'B', voucher_number: 1 }], count: 1 },
      ],
      invoices: { data: null, count: 0 },
      supplier_invoices: { data: null, count: 0 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), {
      stored: 'accrual',
      requested: 'cash',
      reason: '  Fel metod vid inflyttningen  ',
    })
    expect(check.kind).toBe('correction')
    if (check.kind !== 'correction') return
    expect(check.correction).toEqual({
      from: 'accrual',
      to: 'cash',
      reason: 'Fel metod vid inflyttningen',
      fiscal_period_id: 'fp-2026',
      fiscal_year: 'Räkenskapsår 2026',
      posted_entries: 112,
      method_timed_entries: 1,
    })
    expect(check.warnings).toEqual([
      expect.objectContaining({ code: 'ACCOUNTING_METHOD_CORRECTED_REVIEW_ENTRIES', message_sv: expect.stringContaining('(B1)') }),
    ])
  })

  it('allows a correction with no warning when the invoice flows booked nothing this year', async () => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: [{ data: null, count: 74 }, { data: [], count: 0 }],
      invoices: { data: null, count: 0 },
      supplier_invoices: { data: null, count: 0 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), {
      stored: 'accrual',
      requested: 'cash',
      reason: 'Fel metod vid inflyttningen',
    })
    expect(check).toMatchObject({ kind: 'correction', warnings: [] })
  })

  it('fails closed when a read fails', async () => {
    const client = makeClient({
      fiscal_periods: PERIOD,
      journal_entries: { data: null, count: 3 },
      invoices: { data: null, error: { message: 'statement timeout', code: '57014' } },
      supplier_invoices: { data: null, count: 0 },
    })
    const check = await checkAccountingMethodChange(ctxFor(client), {
      stored: 'accrual',
      requested: 'cash',
      reason: 'Fel metod vid inflyttningen',
    })
    expect(check).toMatchObject({ kind: 'refused', outcome: { ok: false, code: 'UNKNOWN_ERROR' } })
  })
})

describe('recordAccountingMethodCorrection', () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const correction = {
    from: 'accrual',
    to: 'cash',
    reason: 'Fel metod vid inflyttningen',
    fiscal_period_id: 'fp-2026',
    fiscal_year: 'Räkenskapsår 2026',
    posted_entries: 112,
    method_timed_entries: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes who, when and why to audit_log as a passed guard', async () => {
    serviceInsert.mockResolvedValue({ error: null })
    const warning = await recordAccountingMethodCorrection(
      { companyId: 'c1', userId: 'u1', log: log as never, pendingOperationId: 'op-1' },
      correction,
      'settings-1',
    )
    expect(warning).toBeNull()
    expect(serviceInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1',
      company_id: 'c1',
      action: 'GUARD_BYPASSED',
      table_name: 'company_settings',
      record_id: 'settings-1',
      old_state: { accounting_method: 'accrual' },
      new_state: expect.objectContaining({
        guard: ACCOUNTING_METHOD_MID_YEAR_GUARD,
        to: 'cash',
        reason: 'Fel metod vid inflyttningen',
        posted_entries: 112,
        pending_operation_id: 'op-1',
      }),
    }))
  })

  it('answers a warning, never a throw, when the row cannot be written', async () => {
    serviceInsert.mockResolvedValue({ error: { message: 'denied', code: '42501' } })
    const warning = await recordAccountingMethodCorrection({ companyId: 'c1', userId: 'u1', log: log as never }, correction, null)
    expect(warning).toMatchObject({ code: 'ACCOUNTING_METHOD_CORRECTION_NOT_RECORDED' })
    expect(log.error).toHaveBeenCalled()
  })
})
