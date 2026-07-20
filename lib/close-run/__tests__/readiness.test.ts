import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(),
}))
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { buildMonthEndReadinessReport, monthRange } from '../readiness'

const mockRecon = vi.mocked(getReconciliationStatus)

function reconResult(overrides: Record<string, unknown> = {}) {
  return {
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
    matched_count: 10,
    ...overrides,
  } as Awaited<ReturnType<typeof getReconciliationStatus>>
}

describe('monthRange', () => {
  it('computes inclusive month bounds including February and December', () => {
    expect(monthRange('2026-06')).toEqual({ start: '2026-06-01', end: '2026-06-30' })
    expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' })
  })

  it('rejects malformed months', () => {
    expect(() => monthRange('2026-13')).toThrow()
    expect(() => monthRange('2026-6')).toThrow()
  })
})

describe('buildMonthEndReadinessReport', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    mockRecon.mockResolvedValue(reconResult())
  })

  // Queue order = synchronous builder-creation order: settings, transactions,
  // supplier_invoices, drafts, receipts (recon is module-mocked).
  function enqueueAll({
    lockedThrough = null as string | null,
    unbooked = 0,
    unattested = 0,
    drafts = 0,
    receiptRows = [] as unknown[],
  } = {}) {
    mock.enqueue({ data: { bookkeeping_locked_through: lockedThrough } })
    mock.enqueue({ data: null, count: unbooked })
    mock.enqueue({ data: null, count: unattested })
    mock.enqueue({ data: null, count: drafts })
    mock.enqueue({ data: receiptRows })
  }

  function run() {
    return buildMonthEndReadinessReport(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      '2026-06',
    )
  }

  it('is ready when every check passes', async () => {
    enqueueAll()
    const report = await run()
    expect(report.ready).toBe(true)
    expect(report.alreadyLocked).toBe(false)
    expect(report.checks).toHaveLength(5)
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('unbooked transactions and drafts are blockers', async () => {
    enqueueAll({ unbooked: 3, drafts: 1 })
    const report = await run()
    expect(report.ready).toBe(false)
    expect(report.checks.find((c) => c.key === 'unbooked_transactions')).toMatchObject({
      status: 'blocker',
      count: 3,
    })
    expect(report.checks.find((c) => c.key === 'draft_entries')?.status).toBe('blocker')
  })

  it('reconciliation difference above tolerance blocks; small drift warns', async () => {
    enqueueAll()
    mockRecon.mockResolvedValue(
      reconResult({ is_reconciled: false, difference: 512.34, unmatched_transaction_count: 2 }),
    )
    const blocked = await run()
    expect(blocked.checks.find((c) => c.key === 'bank_unreconciled')).toMatchObject({
      status: 'blocker',
      amount: 512.34,
    })

    enqueueAll()
    mockRecon.mockResolvedValue(
      reconResult({ is_reconciled: false, difference: -12.5, unmatched_transaction_count: 1 }),
    )
    const warned = await run()
    expect(warned.checks.find((c) => c.key === 'bank_unreconciled')?.status).toBe('warning')
    expect(warned.ready).toBe(true)
  })

  it('high-value posted entries without underlag warn but do not block', async () => {
    enqueueAll({
      receiptRows: [
        {
          id: 'je-1',
          document_attachments: [],
          journal_entry_lines: [{ debit_amount: 5000 }],
        },
        {
          id: 'je-2',
          document_attachments: [{ id: 'doc' }],
          journal_entry_lines: [{ debit_amount: 9000 }],
        },
        {
          id: 'je-3',
          document_attachments: [],
          journal_entry_lines: [{ debit_amount: 100 }],
        },
      ],
    })
    const report = await run()
    expect(report.checks.find((c) => c.key === 'missing_receipts_high_value')).toMatchObject({
      status: 'warning',
      count: 1,
    })
    expect(report.ready).toBe(true)
  })

  it('a failed check reads unknown and blocks readiness (fail-closed)', async () => {
    mock.enqueue({ data: { bookkeeping_locked_through: null } })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    mock.enqueue({ data: null, count: 0 })
    mock.enqueue({ data: null, count: 0 })
    mock.enqueue({ data: [] })

    const report = await run()
    expect(report.checks.find((c) => c.key === 'unbooked_transactions')).toMatchObject({
      status: 'unknown',
      count: null,
    })
    expect(report.ready).toBe(false)
  })

  it('flags an already-locked month', async () => {
    enqueueAll({ lockedThrough: '2026-06-30' })
    const report = await run()
    expect(report.alreadyLocked).toBe(true)
    expect(report.lockedThrough).toBe('2026-06-30')
  })
})
