/**
 * Unit tests for the stuck-'committing' recovery sweep (issue #843).
 *
 * The transition legality against real triggers is covered by
 * tests/pg/pending-operations-committing-recovery.pg.test.ts; these tests pin
 * the decision logic: row selection filters, per-type evidence probes, the
 * conservative rejected-by-default outcome, CAS guards, and the metric-style
 * pending_op_recovery log line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  STUCK_COMMITTING_THRESHOLD_MINUTES,
  buildRecoveryUpdate,
  findPostedEvidence,
  recoverStuckCommittingOperations,
  type StuckCommittingRow,
} from '../recover-stuck-committing'
import type { Logger } from '@/lib/logger'

interface FilterCall {
  method: string
  args: unknown[]
}

interface QueryCapture {
  kind: 'from' | 'rpc'
  target: string
  rpcArgs?: unknown
  payload?: Record<string, unknown>
  filters: FilterCall[]
}

function createCapturingSupabase() {
  const captures: QueryCapture[] = []
  const results: Array<{ data: unknown; error: unknown }> = []

  const buildChain = (capture: QueryCapture) => {
    const result = results.shift() ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        if (method === 'update') {
          capture.payload = args[0] as Record<string, unknown>
        } else {
          capture.filters.push({ method, args })
        }
        return chain
      }
    for (const method of ['select', 'update', 'eq', 'lt', 'order', 'range', 'maybeSingle']) {
      chain[method] = vi.fn(record(method))
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  }

  const supabase = {
    from: vi.fn((table: string) => {
      const capture: QueryCapture = { kind: 'from', target: table, filters: [] }
      captures.push(capture)
      return buildChain(capture)
    }),
    rpc: vi.fn((name: string, args: unknown) => {
      const capture: QueryCapture = { kind: 'rpc', target: name, rpcArgs: args, filters: [] }
      captures.push(capture)
      return buildChain(capture)
    }),
  } as unknown as SupabaseClient

  return {
    supabase,
    captures,
    enqueue(result: { data?: unknown; error?: unknown }) {
      results.push({ data: result.data ?? null, error: result.error ?? null })
    },
  }
}

function createLogSpy(): { log: Logger; calls: Array<{ level: string; args: unknown[] }> } {
  const calls: Array<{ level: string; args: unknown[] }> = []
  const log = {
    info: vi.fn((...args: unknown[]) => calls.push({ level: 'info', args })),
    warn: vi.fn((...args: unknown[]) => calls.push({ level: 'warn', args })),
    error: vi.fn((...args: unknown[]) => calls.push({ level: 'error', args })),
    child: vi.fn(),
  } as unknown as Logger
  return { log, calls }
}

function makeRow(overrides: Partial<StuckCommittingRow> = {}): StuckCommittingRow {
  return {
    id: 'op-1',
    company_id: 'company-1',
    operation_type: 'create_customer',
    params: {},
    updated_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildRecoveryUpdate', () => {
  it('finalizes to committed with the recovered marker when evidence exists', () => {
    const row = makeRow({ operation_type: 'categorize_transaction' })
    const update = buildRecoveryUpdate(row, 'transaction_booked', '2026-07-22T02:30:00.000Z')

    expect(update.status).toBe('committed')
    expect(update.resolved_at).toBe('2026-07-22T02:30:00.000Z')
    expect(update.result_data.recovered).toBe(true)
    expect(update.result_data.recovery).toMatchObject({
      reason: 'stuck_committing',
      evidence: 'transaction_booked',
      stuck_since: row.updated_at,
      swept_at: '2026-07-22T02:30:00.000Z',
    })
  })

  it('rejects with an explanation when no evidence exists, never back to pending', () => {
    const row = makeRow()
    const update = buildRecoveryUpdate(row, null, '2026-07-22T02:30:00.000Z')

    expect(update.status).toBe('rejected')
    expect(update.result_data.auto_rejected).toBe(true)
    // Distinct from 'expired' so the UI's "Utgick automatiskt" badge (strict
    // on reason === 'expired') never claims recovery rows.
    expect(update.result_data.reason).toBe('stuck_committing')
    expect(update.result_data.recovery).toMatchObject({
      evidence: null,
      stuck_since: row.updated_at,
    })
    expect((update.result_data.recovery as { note: string }).note).toMatch(/re-staging/)
  })
})

describe('findPostedEvidence', () => {
  it('categorize_transaction: booked target transaction is positive evidence', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    enqueue({ data: true })

    const evidence = await findPostedEvidence(
      supabase,
      makeRow({
        operation_type: 'categorize_transaction',
        params: { transaction_id: 'tx-1' },
      }),
    )

    expect(evidence).toBe('transaction_booked')
    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({
      kind: 'rpc',
      target: 'is_transaction_booked',
      rpcArgs: { p_transaction_id: 'tx-1' },
    })
  })

  it('categorize_transaction: unbooked target means no evidence', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    enqueue({ data: false })

    const evidence = await findPostedEvidence(
      supabase,
      makeRow({
        operation_type: 'categorize_transaction',
        params: { transaction_id: 'tx-1' },
      }),
    )

    expect(evidence).toBeNull()
  })

  it('categorize_transaction with allow_duplicate skips the probe: booked proves nothing', async () => {
    const { supabase, captures } = createCapturingSupabase()

    const evidence = await findPostedEvidence(
      supabase,
      makeRow({
        operation_type: 'categorize_transaction',
        params: { transaction_id: 'tx-1', allow_duplicate: true },
      }),
    )

    expect(evidence).toBeNull()
    expect(captures).toHaveLength(0)
  })

  it('link_transaction_journal_entry: the exact tx+entry pair must be linked', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    enqueue({ data: null }) // transactions.journal_entry_id miss
    enqueue({ data: { id: 'link-1' } }) // transaction_voucher_links hit

    const evidence = await findPostedEvidence(
      supabase,
      makeRow({
        operation_type: 'link_transaction_journal_entry',
        params: { transaction_id: 'tx-1', journal_entry_id: 'je-1' },
      }),
    )

    expect(evidence).toBe('transaction_linked_to_target_entry')
    expect(captures[0].target).toBe('transactions')
    expect(captures[1].target).toBe('transaction_voucher_links')
    expect(captures[1].filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['company_id', 'company-1'] },
        { method: 'eq', args: ['transaction_id', 'tx-1'] },
        { method: 'eq', args: ['journal_entry_id', 'je-1'] },
      ]),
    )
  })

  it('match_transaction_invoice: an invoice_payments row for the exact pair is evidence', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    enqueue({ data: { id: 'payment-1' } })

    const evidence = await findPostedEvidence(
      supabase,
      makeRow({
        operation_type: 'match_transaction_invoice',
        params: { transaction_id: 'tx-1', invoice_id: 'inv-1' },
      }),
    )

    expect(evidence).toBe('invoice_payment_recorded')
    expect(captures[0].target).toBe('invoice_payments')
  })

  it('types without a reliable probe return null without touching the database', async () => {
    const { supabase, captures } = createCapturingSupabase()

    for (const operationType of ['create_customer', 'send_invoice', 'lock_period', 'create_voucher']) {
      const evidence = await findPostedEvidence(
        supabase,
        makeRow({ operation_type: operationType, params: { transaction_id: 'tx-1' } }),
      )
      expect(evidence).toBeNull()
    }
    expect(captures).toHaveLength(0)
  })

  it('throws on probe errors so the caller skips instead of rejecting', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    enqueue({ error: { message: 'connection reset' } })

    await expect(
      findPostedEvidence(
        supabase,
        makeRow({
          operation_type: 'categorize_transaction',
          params: { transaction_id: 'tx-1' },
        }),
      ),
    ).rejects.toThrow(/connection reset/)
  })
})

describe('recoverStuckCommittingOperations', () => {
  it('lists committing rows older than the threshold and drives them terminal with a CAS', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    const { log, calls } = createLogSpy()
    const now = new Date('2026-07-22T02:30:00.000Z')

    const bookedOp = makeRow({
      id: 'op-booked',
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1' },
    })
    const unknownOp = makeRow({ id: 'op-unknown', operation_type: 'create_customer' })

    enqueue({ data: [bookedOp, unknownOp] }) // listing page
    enqueue({ data: true }) // is_transaction_booked probe
    enqueue({ data: { id: 'op-booked' } }) // CAS finalize committed
    enqueue({ data: { id: 'op-unknown' } }) // CAS finalize rejected

    const summary = await recoverStuckCommittingOperations(supabase, { log, now })

    expect(summary).toEqual({ scanned: 2, committed: 1, rejected: 1, skipped: 0 })

    // Listing: status CAS filter + threshold on updated_at (the claim
    // timestamp, bumped by the updated_at trigger on the pending->committing
    // CAS) + stable order for fetchAllRows pagination.
    const listing = captures[0]
    expect(listing.target).toBe('pending_operations')
    expect(listing.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['status', 'committing'] },
        {
          method: 'lt',
          args: [
            'updated_at',
            new Date(
              now.getTime() - STUCK_COMMITTING_THRESHOLD_MINUTES * 60_000,
            ).toISOString(),
          ],
        },
      ]),
    )
    expect(listing.filters.some((f) => f.method === 'order')).toBe(true)

    // Committed finalize: CAS-guarded on status='committing'.
    const committedWrite = captures[2]
    expect(committedWrite.payload).toMatchObject({ status: 'committed' })
    expect((committedWrite.payload!.result_data as Record<string, unknown>).recovered).toBe(true)
    expect(committedWrite.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', 'op-booked'] },
        { method: 'eq', args: ['status', 'committing'] },
      ]),
    )

    // No-evidence finalize: terminal rejected, never back to pending.
    const rejectedWrite = captures[3]
    expect(rejectedWrite.payload).toMatchObject({ status: 'rejected' })
    expect((rejectedWrite.payload!.result_data as Record<string, unknown>).auto_rejected).toBe(true)
    expect(rejectedWrite.filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', 'op-unknown'] },
        { method: 'eq', args: ['status', 'committing'] },
      ]),
    )

    // Metric-style log line per recovered row.
    const recoveryLines = calls.filter((c) => c.args[0] === 'pending_op_recovery')
    expect(recoveryLines).toHaveLength(2)
    const outcomes = recoveryLines.map(
      (c) => (c.args[1] as Record<string, unknown>).outcome,
    )
    expect(outcomes).toEqual(['committed', 'rejected'])
    expect(recoveryLines[0].args[1]).toMatchObject({
      pendingOperationId: 'op-booked',
      companyId: 'company-1',
      operationType: 'categorize_transaction',
      evidence: 'transaction_booked',
    })
  })

  it('skips a row when the evidence probe fails, leaving it for the next run', async () => {
    const { supabase, captures, enqueue } = createCapturingSupabase()
    const { log, calls } = createLogSpy()

    enqueue({
      data: [
        makeRow({
          id: 'op-probe-fail',
          operation_type: 'categorize_transaction',
          params: { transaction_id: 'tx-1' },
        }),
      ],
    })
    enqueue({ error: { message: 'probe down' } })

    const summary = await recoverStuckCommittingOperations(supabase, { log })

    expect(summary).toEqual({ scanned: 1, committed: 0, rejected: 0, skipped: 1 })
    // No terminal write was attempted: only the listing + the failed probe.
    expect(captures.filter((c) => c.payload !== undefined)).toHaveLength(0)
    const line = calls.find((c) => c.args[0] === 'pending_op_recovery')
    expect(line?.level).toBe('error')
  })

  it('counts a lost CAS as skipped when a concurrent finalize resolved the row first', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    const { log, calls } = createLogSpy()

    enqueue({ data: [makeRow({ id: 'op-raced' })] })
    enqueue({ data: null }) // CAS matched zero rows

    const summary = await recoverStuckCommittingOperations(supabase, { log })

    expect(summary).toEqual({ scanned: 1, committed: 0, rejected: 0, skipped: 1 })
    const line = calls.find((c) => c.args[0] === 'pending_op_recovery')
    expect((line?.args[1] as Record<string, unknown>).outcome).toBe('lost_cas')
  })

  it('returns an empty summary when nothing is stuck', async () => {
    const { supabase, enqueue } = createCapturingSupabase()
    const { log } = createLogSpy()

    enqueue({ data: [] })

    const summary = await recoverStuckCommittingOperations(supabase, { log })

    expect(summary).toEqual({ scanned: 0, committed: 0, rejected: 0, skipped: 0 })
  })
})
