/**
 * setTransactionIgnored (issue #1661): the shared core behind the dashboard
 * ignore route, the v1 ignore verb and the staged MCP ignore_transaction
 * executor.
 *
 * Pins the contract the three doors rely on: "already booked" is decided by
 * isTransactionBooked() across all three anchors (journal_entry_id, payment
 * allocations, voucher links), the flag flip is idempotent, restore skips the
 * booked check (the DB CHECK already guarantees an ignored row is unbooked),
 * dry run writes nothing, and DB failures throw with their SQLSTATE intact.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { setTransactionIgnored } from '../ignore'

const TX_ID = '00000000-0000-4000-8000-0000000000aa'

const unbookedRow = { id: TX_ID, journal_entry_id: null, is_ignored: false }

/** Queue the three junction lookups (voucher links, invoice payments, supplier payments). */
function enqueueNoAnchors(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: [] })
  enqueue({ data: [] })
  enqueue({ data: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('setTransactionIgnored: refusals', () => {
  it('returns 404 TX_CATEGORIZE_TX_NOT_FOUND when the row is not in this company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND', status: 404 })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a directly booked row without consulting the junction tables', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...unbookedRow, journal_entry_id: 'je-1' } })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a bulk-booked row anchored only through transaction_voucher_links', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueue({ data: [{ transaction_id: TX_ID }] }) // voucher links
    enqueue({ data: [] }) // invoice payments
    enqueue({ data: [] }) // supplier payments

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a multi-allocated row anchored only through invoice_payments', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueue({ data: [] })
    enqueue({ data: [{ transaction_id: TX_ID }] }) // invoice payments
    enqueue({ data: [] })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
  })

  it('refuses a row anchored only through supplier_invoice_payments', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ transaction_id: TX_ID }] }) // supplier payments

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
  })

  it('throws (with the SQLSTATE) when the fetch itself fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'db down', code: '57P01' } })

    await expect(
      setTransactionIgnored(supabase as never, 'company-1', TX_ID, true),
    ).rejects.toMatchObject({ message: 'db down', code: '57P01' })
  })
})

describe('setTransactionIgnored: writes', () => {
  it('flips is_ignored on an unbooked row scoped to the company (happy path)', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueueNoAnchors(enqueue)
    enqueue({ data: null })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({
      ok: true,
      transaction_id: TX_ID,
      is_ignored: true,
      changed: true,
      dry_run: false,
    })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: true }]])
    // Defense in depth: the update is filtered by company_id, not just id.
    const eqArgs = calls.filter((c) => c.table === 'transactions' && c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
  })

  it('is idempotent: an already-ignored row returns changed=false and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...unbookedRow, is_ignored: true } })
    enqueueNoAnchors(enqueue)

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toMatchObject({ ok: true, is_ignored: true, changed: false })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('dry run reports what would change and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueueNoAnchors(enqueue)

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, {
      dryRun: true,
    })

    expect(outcome).toMatchObject({ ok: true, changed: true, dry_run: true })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore clears the flag without the booked check (the DB CHECK already guarantees unbooked)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...unbookedRow, is_ignored: true } })
    enqueue({ data: null }) // update

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, false)

    expect(outcome).toMatchObject({ ok: true, is_ignored: false, changed: true })
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: false }]])
  })

  it('restore on a row that is not ignored is a no-op', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, false)

    expect(outcome).toMatchObject({ ok: true, is_ignored: false, changed: false })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('throws when the update fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueueNoAnchors(enqueue)
    enqueue({ data: null, error: { message: 'db down', code: '57P01' } })

    await expect(
      setTransactionIgnored(supabase as never, 'company-1', TX_ID, true),
    ).rejects.toMatchObject({ code: '57P01' })
  })
})
