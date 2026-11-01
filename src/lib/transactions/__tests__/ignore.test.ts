/**
 * setTransactionIgnored (issue #1661): the shared core behind the dashboard
 * ignore route, the v1 ignore verb and the staged MCP ignore_transaction
 * executor.
 *
 * Pins the contract the three doors rely on: "already booked" is the row's
 * is_booked column (the database reads the anchors, as
 * tests/pg/bank-row-open-read.pg.test.ts proves), the flag flip is idempotent,
 * restore skips the booked check (the DB CHECK already guarantees an ignored
 * row is unbooked), dry run writes nothing, and DB failures throw with their
 * SQLSTATE intact.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { setTransactionIgnored } from '../ignore'
import { recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'

// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

const TX_ID = '00000000-0000-4000-8000-0000000000aa'

const unbookedRow = { id: TX_ID, journal_entry_id: null, is_booked: false, is_ignored: false }

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
    enqueue({ data: { ...unbookedRow, journal_entry_id: 'je-1', is_booked: true } })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a row booked with no pointer (a voucher link, a payment allocation), reading no anchor table', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...unbookedRow, is_booked: true } })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transactions', 'select')[0][0]).toContain('is_booked')
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    expect(findCalls('invoice_payments', 'select')).toEqual([])
    expect(findCalls('supplier_invoice_payments', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
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

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toMatchObject({ ok: true, is_ignored: true, changed: false })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('dry run reports what would change and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })

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
    enqueue({ data: null, error: { message: 'db down', code: '57P01' } })

    await expect(
      setTransactionIgnored(supabase as never, 'company-1', TX_ID, true),
    ).rejects.toMatchObject({ code: '57P01' })
  })
})

describe('setTransactionIgnored: suggestion_log', () => {
  it('records an ignore as a dismissal, with the suggestions taken before the flag flips', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unbookedRow })
    enqueue({ data: null })

    await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(vi.mocked(snapshotSuggestions)).toHaveBeenCalledWith(supabase, 'company-1', [TX_ID])
    expect(vi.mocked(recordDecisions)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1' }),
      [{ transactionId: TX_ID, final: null, checks: [{ id: 'already_booked', result: 'pass', detail: null }] }],
      'user-1',
    )
  })

  it('records nothing for a restore, a dry run or a row already ignored', async () => {
    const restore = createQueuedMockSupabase()
    restore.enqueue({ data: { ...unbookedRow, is_ignored: true } })
    restore.enqueue({ data: null })
    await setTransactionIgnored(restore.supabase as never, 'company-1', TX_ID, false, { userId: 'user-1' })

    const dry = createQueuedMockSupabase()
    dry.enqueue({ data: unbookedRow })
    await setTransactionIgnored(dry.supabase as never, 'company-1', TX_ID, true, { dryRun: true, userId: 'user-1' })

    const already = createQueuedMockSupabase()
    already.enqueue({ data: { ...unbookedRow, is_ignored: true } })
    await setTransactionIgnored(already.supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(vi.mocked(recordDecisions)).not.toHaveBeenCalled()
  })
})

describe('setTransactionIgnored: a pointer at a verifikat no longer posted', () => {
  // The row reads as unbooked, but an ignored row may hold no pointer
  // (CHECK transactions_is_ignored_no_journal_entry), so it goes with the flag.
  const stalePointerRow = { ...unbookedRow, journal_entry_id: 'je-reversed', reconciliation_method: null }

  it('releases the pointer with the flag, logged as unmatched, and reads no verifikat', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: stalePointerRow })
    enqueue({ data: [{ id: TX_ID }] }) // the update
    enqueue({ data: null }) // payment_match_log insert

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: true, transaction_id: TX_ID, is_ignored: true, changed: true, dry_run: false })
    expect(findCalls('transactions', 'update')).toEqual([
      [{ is_ignored: true, journal_entry_id: null, reconciliation_method: null, is_business: null }],
    ])
    const eqArgs = calls.filter((c) => c.table === 'transactions' && c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['journal_entry_id', 'je-reversed'])
    expect(findCalls('payment_match_log', 'insert')).toEqual([
      [
        expect.objectContaining({
          user_id: 'user-1',
          action: 'unmatched',
          previous_state: expect.objectContaining({
            journal_entry_id: 'je-reversed',
            reason: 'verifikat_no_longer_posted',
          }),
        }),
      ],
    ])
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('refuses when no person is named to record the unlink for', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: stalePointerRow })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('a dry run reports the change and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: stalePointerRow })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1', dryRun: true })

    expect(outcome).toMatchObject({ ok: true, is_ignored: true, changed: true, dry_run: true })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('payment_match_log', 'insert')).toEqual([])
  })
})

describe('setTransactionIgnored: a hand-made row whose verifikat books no bank line (PH 214)', () => {
  // A sale typed in as a transaction and booked on the clearing account
  // (debit 1580, credit 3001/2611) before the bank-anchor guard: nothing on 1930.
  const saleRow = {
    ...unbookedRow,
    journal_entry_id: 'je-sale',
    is_booked: true,
    reconciliation_method: null,
    cash_account_id: null,
    currency: 'SEK',
    amount: 4277,
    bank_connection_id: null,
    import_source: null,
    invoice_id: null,
    supplier_invoice_id: null,
  }

  /** The stale-anchor reads: settlement 1930, the verifikat posted, its lines on 1930 as given, no other anchor. */
  function enqueueStaleReads(
    enqueue: (r: { data?: unknown; error?: unknown }) => void,
    linesOn1930: unknown[] = [],
  ) {
    enqueue({ data: [{ ledger_account: '1930' }] }) // the only enabled SEK cash account
    enqueue({ data: [{ id: 'je-sale', status: 'posted' }] })
    enqueue({ data: linesOn1930 })
    if (linesOn1930.length > 0) return
    enqueue({ data: [] }) // voucher links
    enqueue({ data: [] }) // invoice payments
    enqueue({ data: [] }) // supplier payments
  }

  it('drops the link and ignores the row in one compare-and-set write, logged as unmatched; the verifikat is untouched', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: saleRow })
    enqueueStaleReads(enqueue)
    enqueue({ data: [{ id: TX_ID }] }) // the update
    enqueue({ data: null }) // payment_match_log insert

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: true, transaction_id: TX_ID, is_ignored: true, changed: true, dry_run: false })
    expect(findCalls('transactions', 'update')).toEqual([
      [{ is_ignored: true, journal_entry_id: null, reconciliation_method: null, is_business: null }],
    ])
    const eqArgs = calls.filter((c) => c.table === 'transactions' && c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['journal_entry_id', 'je-sale'])
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('payment_match_log', 'insert')).toEqual([
      [
        expect.objectContaining({
          user_id: 'user-1',
          transaction_id: TX_ID,
          action: 'unmatched',
          previous_state: expect.objectContaining({
            journal_entry_id: 'je-sale',
            reason: 'verifikat_books_no_bank_line',
          }),
        }),
      ],
    ])
    // No verifikat is written or changed.
    expect(findCalls('journal_entries', 'update')).toEqual([])
    expect(findCalls('journal_entry_lines', 'update')).toEqual([])
  })

  it('still refuses a normal booking: the verifikat debits the bank account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: saleRow })
    enqueueStaleReads(enqueue, [{ journal_entry_id: 'je-sale', account_number: '1930', debit_amount: 4277, credit_amount: 0 }])

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('still refuses a bank-feed row of the same shape: money moved there, the verifikat is what to correct', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...saleRow, bank_connection_id: 'conn-1' } })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('journal_entries', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('still refuses when no person is named to record the unlink for', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: saleRow })

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true)

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('a dry run reports the change and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: saleRow })
    enqueueStaleReads(enqueue)

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1', dryRun: true })

    expect(outcome).toMatchObject({ ok: true, is_ignored: true, changed: true, dry_run: true })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('payment_match_log', 'insert')).toEqual([])
  })

  it('refuses when the pointer changed under it (a concurrent link or storno wins)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: saleRow })
    enqueueStaleReads(enqueue)
    enqueue({ data: [] }) // the compare-and-set matched no row

    const outcome = await setTransactionIgnored(supabase as never, 'company-1', TX_ID, true, { userId: 'user-1' })

    expect(outcome).toEqual({ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 })
    expect(findCalls('payment_match_log', 'insert')).toEqual([])
  })
})
