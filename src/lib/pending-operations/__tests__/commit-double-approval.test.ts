/**
 * Approving the same pending operation twice never commits twice.
 *
 * Every approval door (the web single and bulk approval, the MCP approve
 * tool, a client resending a broken approve call) ends in
 * commitPendingOperation, which flips the row pending -> committing in one
 * conditional UPDATE before any side effect. Only the caller whose UPDATE
 * matched runs the executor; the other gets a 409 and touches nothing. This
 * runs two approvals concurrently and one after the commit against a table
 * double with the same compare-and-set semantics, and counts the executor.
 * The SQL itself is pinned in actor-and-risk.pg.test.ts ('second concurrent
 * claim sees committing'). The executor kind does not matter: the claim sits
 * before the dispatch on operation_type.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'

const executor = vi.hoisted(() => ({ setTransactionIgnored: vi.fn() }))

vi.mock('@/lib/transactions/ignore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/ignore')>()),
  setTransactionIgnored: (...args: unknown[]) => executor.setTransactionIgnored(...args),
}))

import { commitPendingOperation } from '../commit'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const TRANSACTION_ID = '22222222-2222-4222-8222-222222222222'

function pendingOperation(): PendingOperation {
  return {
    id: OPERATION_ID,
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'ignore_transaction',
    status: 'pending',
    title: 'Ignorera transaktion',
    params: { transaction_id: TRANSACTION_ID, ignored: true },
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Agent key',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-15T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-15T00:00:00Z',
  } as PendingOperation
}

/**
 * One pending_operations row behind a client that applies an UPDATE only when
 * every eq() filter matches the row as it is NOW: the compare-and-set the
 * claim relies on. Each caller holds its own in-memory copy of the operation
 * (status 'pending'), exactly as two requests that each read it first do.
 */
function rowBackedClient(row: { status: string; result_data?: unknown }) {
  const applied: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      if (table !== 'pending_operations') throw new Error(`unexpected table ${table}`)
      let patch: Record<string, unknown> | null = null
      const filters: Array<[string, unknown]> = []
      const apply = () => {
        const matches = filters.every(([column, value]) => column === 'id' || (row as Record<string, unknown>)[column] === value)
        if (!patch || !matches) return { data: null, error: null }
        Object.assign(row, patch)
        applied.push(patch)
        return { data: { id: OPERATION_ID }, error: null }
      }
      const builder = {
        update(next: Record<string, unknown>) {
          patch = next
          return builder
        },
        eq(column: string, value: unknown) {
          filters.push([column, value])
          return builder
        },
        select: () => builder,
        maybeSingle: async () => apply(),
        then: (resolve: (value: unknown) => void) => resolve(apply()),
      }
      return builder
    },
  }
  return { client, applied }
}

beforeEach(() => {
  vi.clearAllMocks()
  executor.setTransactionIgnored.mockImplementation(async () => {
    // Long enough for the second approval to reach its claim mid-commit.
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: true, transaction_id: TRANSACTION_ID, is_ignored: true, changed: true }
  })
})

describe('commitPendingOperation: one commit per operation', () => {
  it('runs the executor once for two concurrent approvals; the loser gets 409 and writes nothing', async () => {
    const row = { status: 'pending' }
    const { client, applied } = rowBackedClient(row)

    const [first, second] = await Promise.all([
      commitPendingOperation(client as never, 'user-1', 'company-1', pendingOperation()),
      commitPendingOperation(client as never, 'user-1', 'company-1', pendingOperation()),
    ])

    expect(executor.setTransactionIgnored).toHaveBeenCalledTimes(1)
    expect([first.status, second.status].sort()).toEqual(['committed', 'failed'])
    const loser = first.status === 'failed' ? first : second
    expect(loser.http_status).toBe(409)
    expect(loser.operation_status).toBeUndefined()
    // pending -> committing once, committing -> committed once; nothing from the loser.
    expect(applied.map((patch) => patch.status)).toEqual(['committing', 'committed'])
    expect(row.status).toBe('committed')
  })

  it('does not run the executor again for an approval resent after the commit', async () => {
    const row = { status: 'pending' }
    const { client } = rowBackedClient(row)

    const first = await commitPendingOperation(client as never, 'user-1', 'company-1', pendingOperation())
    expect(first.status).toBe('committed')

    // The retry carries the operation as the client first read it: pending.
    const retry = await commitPendingOperation(client as never, 'user-1', 'company-1', pendingOperation())
    expect(retry).toMatchObject({ status: 'failed', http_status: 409 })
    expect(executor.setTransactionIgnored).toHaveBeenCalledTimes(1)
    expect(row.status).toBe('committed')
  })
})

describe('commitPendingOperation: only a person approves', () => {
  it.each(['cron', 'system'] as const)('never lets a %s turn approve; the op stays pending, untouched', async (type) => {
    const row = { status: 'pending' }
    const { client, applied } = rowBackedClient(row)

    const result = await commitPendingOperation(client as never, 'user-1', 'company-1', pendingOperation(), {
      actor: { type },
    })

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 403,
      code: 'PENDING_OPERATION_SYSTEM_APPROVAL_FORBIDDEN',
      operation_status: 'pending',
    })
    expect(executor.setTransactionIgnored).not.toHaveBeenCalled()
    expect(applied).toEqual([])
    expect(row.status).toBe('pending')
  })
})
