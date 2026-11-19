/**
 * The decision receipt an approval leaves (lib/suggestion-log/operation.ts):
 * commitPendingOperation, once the executor posted a voucher and the row is
 * committed, records one suggestion_log row of kind 'operation' that names
 * the operation, the approver and the claim, and nothing else in the commit
 * depends on it.
 *
 * Driven through the real commit and the real writer against a table double:
 * pending_operations with the claim's compare-and-set (its answer carries the
 * claim's updated_at, as the update_updated_at_column trigger stamps it),
 * journal_entries with committed_at, and suggestion_log. The executor is a
 * registered operation whose run posts one voucher. The SQL side (the
 * CHECKs, the reader through PostgREST) is pinned in
 * tests/pg/phase1-exit-check.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PendingOperation } from '@/types'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLAIMED_AT = '2026-10-16T10:00:00.000+00:00'
const POSTED_AT = '2026-10-16T10:00:00.400+00:00'

const executor = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('@/lib/operations/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operations/registry')>()
  return {
    ...actual,
    operationForPendingType: (pendingType: string) =>
      pendingType === 'test_post_voucher'
        ? { id: 'test.post-voucher', kind: 'write', input: z.object({ amount: z.number() }), run: executor.run }
        : actual.operationForPendingType(pendingType),
  }
})

import { commitPendingOperation } from '../commit'
import { committingAgentReason } from '../commit-scope'

function pendingOperation(): PendingOperation {
  return {
    id: OPERATION_ID,
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'test_post_voucher',
    status: 'pending',
    title: 'Bokför verifikat',
    params: { amount: 100 },
    preview_data: { total_debit: 100 },
    result_data: null,
    actor_type: 'service_account',
    actor_id: 'key-1',
    actor_label: 'Attestharness',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-16T09:59:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T09:59:00Z',
  } as unknown as PendingOperation
}

/**
 * The three tables the commit and the writer touch. pending_operations
 * applies an UPDATE only when every eq() filter matches the row as it is now
 * (the claim), and answers the claim with its updated_at.
 */
function tableDouble(opts: { insertError?: string } = {}) {
  const operation = { status: 'pending' }
  const entries = [{ id: ENTRY, committed_at: POSTED_AT }]
  const receipts: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      let patch: Record<string, unknown> | null = null
      const eqs: Array<[string, unknown]> = []
      let ids: string[] = []
      let since: string | null = null
      const answer = () => {
        if (table === 'pending_operations') {
          const matches = eqs.every(([column, value]) => column === 'id' || (operation as Record<string, unknown>)[column] === value)
          if (!patch || !matches) return { data: null, error: null }
          Object.assign(operation, patch)
          return { data: { id: OPERATION_ID, updated_at: CLAIMED_AT }, error: null }
        }
        if (table === 'journal_entries') {
          return { data: entries.filter((e) => ids.includes(e.id) && since !== null && e.committed_at >= since).map((e) => ({ id: e.id })), error: null }
        }
        if (table === 'suggestion_log') {
          const operationId = eqs.find(([column]) => column === 'pending_operation_id')?.[1]
          return {
            data: receipts
              .filter((r) => r.pending_operation_id === operationId)
              .map((r) => ({ id: r.id, journal_entry_id: (r.final as { journal_entry_id: string }).journal_entry_id })),
            error: null,
          }
        }
        throw new Error(`unexpected table ${table}`)
      }
      const builder = {
        update(next: Record<string, unknown>) {
          patch = next
          return builder
        },
        eq(column: string, value: unknown) {
          eqs.push([column, value])
          return builder
        },
        in(_column: string, values: string[]) {
          ids = values
          return builder
        },
        gte(_column: string, value: string) {
          since = value
          return builder
        },
        select: () => builder,
        order: () => builder,
        range: () => builder,
        maybeSingle: async () => answer(),
        then: (resolve: (value: unknown) => void) => resolve(answer()),
        async insert(rows: Array<Record<string, unknown>>) {
          if (opts.insertError) return { error: { message: opts.insertError } }
          for (const row of rows) receipts.push({ id: `receipt-${receipts.length + 1}`, ...row })
          return { error: null }
        },
      }
      return builder
    },
  }
  return { client: client as never, operation, receipts }
}

const approver = { type: 'service_account' as const, label: 'Attestharness', unattendedCommitLimit: null }

beforeEach(() => {
  vi.clearAllMocks()
  executor.run.mockResolvedValue({ ok: true, dryRun: false, data: { journal_entry_id: ENTRY } })
})

describe('commitPendingOperation: the decision receipt', () => {
  it('records one receipt for the voucher the approval posted, naming the operation and the approver', async () => {
    const db = tableDouble()
    const result = await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), {
      commitMethod: 'api_key',
      actor: approver,
    })
    expect(result).toMatchObject({ status: 'committed', data: { journal_entry_id: ENTRY } })
    expect(db.receipts).toHaveLength(1)
    expect(db.receipts[0]).toMatchObject({
      company_id: 'company-1',
      kind: 'operation',
      pending_operation_id: OPERATION_ID,
      outcome: 'accepted',
      acted_on: 0,
      actor_type: 'service_account',
      resolved_by: 'user-1',
      final: { journal_entry_id: ENTRY, operation_type: 'test_post_voucher' },
      policy_version: 'staged-approval.1;approver=credential;unattended_limit=none',
      confidence_band: 'direct',
    })
  })

  it("keeps the stager's agent_reason in the receipt, and visible to every door the executor reaches", async () => {
    const reason = 'Opening balance from the 2025 SIE file the user uploaded; 1930 matches the bank statement.'
    const seen: Array<string | null> = []
    executor.run.mockImplementation(async () => {
      seen.push(committingAgentReason())
      return { ok: true, dryRun: false, data: { journal_entry_id: ENTRY } }
    })
    const db = tableDouble()
    await commitPendingOperation(db.client, 'user-1', 'company-1', { ...pendingOperation(), agent_reason: reason }, {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'anna@example.se' },
    })
    expect(seen).toEqual([reason])
    expect(db.receipts).toHaveLength(1)
    expect(db.receipts[0]).toMatchObject({ kind: 'operation', pending_operation_id: OPERATION_ID, agent_reason: reason })
  })

  it('writes no agent_reason into the receipt of an operation staged without one', async () => {
    const db = tableDouble()
    await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), { actor: approver })
    expect(db.receipts[0]).not.toHaveProperty('agent_reason')
  })

  it('records a person approving in the app as review', async () => {
    const db = tableDouble()
    await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'anna@example.se' },
    })
    expect(db.receipts[0]).toMatchObject({ actor_type: 'user', policy_version: 'staged-approval.1;approver=person', confidence_band: 'review' })
  })

  it('still commits when the receipt cannot be written', async () => {
    const db = tableDouble({ insertError: 'permission denied for table suggestion_log' })
    const result = await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), { actor: approver })
    expect(result).toMatchObject({ status: 'committed', operation_status: 'committed' })
    expect(db.operation.status).toBe('committed')
    expect(db.receipts).toEqual([])
  })

  it('records nothing when the approval did not commit', async () => {
    executor.run.mockResolvedValue({ ok: false, code: 'PERIOD_LOCKED', messageSv: 'Perioden är låst.' })
    const db = tableDouble()
    const result = await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), { actor: approver })
    expect(result.status).not.toBe('committed')
    expect(db.receipts).toEqual([])
  })

  it('records the decision once when the approval is resent after the commit', async () => {
    const db = tableDouble()
    const first = await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), { actor: approver })
    // The retry carries the operation as the client first read it: pending.
    const retry = await commitPendingOperation(db.client, 'user-1', 'company-1', pendingOperation(), { actor: approver })
    expect(first.status).toBe('committed')
    expect(retry).toMatchObject({ status: 'failed', http_status: 409 })
    expect(executor.run).toHaveBeenCalledTimes(1)
    expect(db.receipts).toHaveLength(1)
  })
})
