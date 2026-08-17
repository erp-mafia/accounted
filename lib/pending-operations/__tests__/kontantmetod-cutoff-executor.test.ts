import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return {
    ...actual,
    assessKontantmetodCutoff: vi.fn(),
    postKontantmetodCutoff: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import {
  assessKontantmetodCutoff,
  buildCutoffLines,
  cutoffPreviewFingerprint,
  KontantmetodCutoffPartialError,
  postKontantmetodCutoff,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'

const collection = {
  receivables: [{
    id: 'inv-1', reference: 'F-1', vatTreatment: 'standard_25' as const,
    outstanding: 1250, vat: 250,
  }],
  payables: [],
  unknownVatTreatment: [],
  strayVatOnZeroRate: [],
}

function makePendingOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  const lines = buildCutoffLines(collection.receivables, collection.payables)
  return {
    id: 'op-1', user_id: 'user-1', company_id: 'company-1',
    operation_type: 'post_kontantmetod_cutoff', status: 'pending', title: 'cut-off',
    params: {
      fiscal_period_id: 'fp-1',
      next_fiscal_period_id: 'fp-2',
      period_end: '2026-12-31',
      entity_type: 'aktiebolag',
      preview_fingerprint: cutoffPreviewFingerprint({
        collection,
        lines,
        entityType: 'aktiebolag',
        periodEnd: '2026-12-31',
      }),
    },
    preview_data: {}, result_data: null, actor_type: 'api_key', actor_id: null,
    actor_label: null, risk_level: 'high', created_at: '2026-08-13T00:00:00Z',
    resolved_at: null, updated_at: '2026-08-13T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

function makeSupabase(options: {
  period?: unknown
  settings?: unknown
  nextPeriod?: unknown
} = {}) {
  const period = options.period ?? {
    id: 'fp-1', period_start: '2026-01-01', period_end: '2026-12-31',
    is_closed: false, locked_at: null,
  }
  const settings = options.settings ?? { accounting_method: 'cash', entity_type: 'aktiebolag' }
  const nextPeriod = Object.prototype.hasOwnProperty.call(options, 'nextPeriod')
    ? options.nextPeriod
    : {
        id: 'fp-2', period_start: '2027-01-01', period_end: '2027-12-31',
        is_closed: false, locked_at: null,
      }
  let fiscalReads = 0
  const updates: Array<{ table: string; value: unknown }> = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'order', 'limit']) chain[name] = () => chain
    chain.update = (value: unknown) => {
      updates.push({ table, value })
      return chain
    }
    const response = () => {
      if (table === 'pending_operations') return { data: { id: 'op-1' }, error: null }
      if (table === 'company_settings') return { data: settings, error: null }
      if (table === 'fiscal_periods') {
        fiscalReads++
        return { data: fiscalReads === 1 ? period : nextPeriod, error: null }
      }
      return { data: null, error: null }
    }
    chain.maybeSingle = async () => response()
    chain.single = async () => response()
    chain.then = (resolve: (value: unknown) => unknown) => resolve(response())
    return chain
  })
  return { auth: {}, from, updates }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2027-02-01T12:00:00Z'))
  vi.mocked(assessKontantmetodCutoff).mockResolvedValue({
    collection,
    lines: buildCutoffLines(collection.receivables, collection.payables),
    postings: {
      complete: false, hasAny: false, receivableEntryId: null,
      receivableReversalId: null, payableEntryId: null, payableReversalId: null,
      missing: ['receivable', 'receivable_reversal'], duplicates: [],
    },
  })
  vi.mocked(postKontantmetodCutoff).mockResolvedValue({
    receivableEntry: { id: 'je-1' } as never,
    receivableReversal: { id: 'je-2' } as never,
    payableEntry: null,
    payableReversal: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('commitPendingOperation: post_kontantmetod_cutoff', () => {
  it('revalidates the frozen preview and posts through the cut-off service', async () => {
    const supabase = makeSupabase()
    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      receivable_entry_id: 'je-1',
      receivable_reversal_entry_id: 'je-2',
      payable_entry_id: null,
      payable_reversal_entry_id: null,
    })
    expect(postKontantmetodCutoff).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1',
      expect.objectContaining({
        fiscalPeriodId: 'fp-1', nextFiscalPeriodId: 'fp-2',
        receivables: collection.receivables, payables: [],
      }),
    )
  })

  it('rejects when the reskontra changed after staging', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({
      collection: {
        ...collection,
        receivables: [{ ...collection.receivables[0]!, outstanding: 1300 }],
      },
      lines: buildCutoffLines([], []),
      postings: { complete: false, hasAny: false, receivableEntryId: null, receivableReversalId: null, payableEntryId: null, payableReversalId: null, missing: [], duplicates: [] },
    })
    const result = await commitPendingOperation(
      makeSupabase() as never, 'user-1', 'company-1', makePendingOp(),
    )
    expect(result).toMatchObject({ status: 'rejected', http_status: 409 })
    expect(result.error).toMatch(/ändrats sedan förhandsgranskningen/i)
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('rejects a duplicate, locked period, wrong accounting method, and missing next period', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({
      collection,
      lines: buildCutoffLines(collection.receivables, []),
      postings: { complete: true, hasAny: true, receivableEntryId: 'je-1', receivableReversalId: 'je-2', payableEntryId: null, payableReversalId: null, missing: [], duplicates: [] },
    })
    await expect(commitPendingOperation(
      makeSupabase() as never, 'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    await expect(commitPendingOperation(
      makeSupabase({ period: { id: 'fp-1', period_end: '2026-12-31', locked_at: 'x', is_closed: false } }) as never,
      'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    await expect(commitPendingOperation(
      makeSupabase({ settings: { accounting_method: 'accrual' } }) as never,
      'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })

    await expect(commitPendingOperation(
      makeSupabase({ nextPeriod: null }) as never,
      'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
  })

  it('rejects preview-affecting settings or period drift', async () => {
    await expect(commitPendingOperation(
      makeSupabase({ settings: { accounting_method: 'cash', entity_type: 'enskild_firma' } }) as never,
      'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    await expect(commitPendingOperation(
      makeSupabase({
        period: {
          id: 'fp-1', period_start: '2026-01-01', period_end: '2026-11-30',
          is_closed: false, locked_at: null,
        },
      }) as never,
      'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses a future-dated cut-off even when it was staged earlier', async () => {
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'))
    await expect(commitPendingOperation(
      makeSupabase() as never, 'user-1', 'company-1', makePendingOp(),
    )).resolves.toMatchObject({ status: 'rejected', http_status: 409 })
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('marks immutable partial work as failed_partial with posted ids', async () => {
    vi.mocked(postKontantmetodCutoff).mockRejectedValueOnce(
      new KontantmetodCutoffPartialError(
        'payable reversal failed',
        { receivable_entry_id: 'ar', receivable_reversal_entry_id: 'ar-rev' },
        new Error('period locked'),
      ),
    )
    const supabase = makeSupabase()
    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(),
    )
    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'partial_commit',
      data: {
        posted_ids: {
          receivable_entry_id: 'ar',
          receivable_reversal_entry_id: 'ar-rev',
        },
      },
    })
    expect(supabase.updates).toContainEqual({
      table: 'pending_operations',
      value: expect.objectContaining({
        status: 'failed_partial',
        result_data: expect.objectContaining({
          posted_ids: {
            receivable_entry_id: 'ar',
            receivable_reversal_entry_id: 'ar-rev',
          },
        }),
      }),
    })
  })
})
