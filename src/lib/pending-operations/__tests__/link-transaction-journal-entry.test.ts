/**
 * Unit tests for commitLinkTransactionJournalEntry.
 * Driven through the public commitPendingOperation dispatcher.
 *
 * The MCP tool gnubok_link_transaction_to_journal_entry stages a
 * 'link_transaction_journal_entry' pending_operation; this dispatcher
 * picks it up, the executor delegates to the shared service in
 * lib/transactions/link-journal-entry.ts. The service is also covered
 * indirectly by the REST route test
 * app/api/transactions/[id]/link-journal-entry/__tests__/route.test.ts;
 * these tests focus on the dispatcher/executor wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeTransaction, makeInvoice } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

const TX_UUID = '550e8400-e29b-41d4-a716-446655440000'
const JE_UUID = '550e8400-e29b-41d4-a716-446655440001'
const INV_UUID = '550e8400-e29b-41d4-a716-446655440002'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'link_transaction_journal_entry',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-30T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-30T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: link_transaction_journal_entry', () => {
  it('returns 400 when transaction_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({ params: { journal_entry_id: JE_UUID } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/transaction_id/i)
  })

  it('returns 404 when transaction not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: { message: 'not found' } }) // tx fetch
    enqueue({ data: null, error: null }) // dispatcher's auto-reject update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 404 is auto-rejected by the dispatcher (so the user can re-stage with
    // adjusted inputs); the originating http_status is preserved on the
    // result for the caller to inspect.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('returns 400 when transaction already linked to a LIVE (posted) entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: 'je-prior' }),
      error: null,
    })
    enqueue({ data: { status: 'posted' }, error: null }) // hasLiveJournalEntryLink: prior link is live
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/already linked/i)
  })

  it('re-links a transaction stranded on a reversed entry (#988)', async () => {
    // The tx still points at a status='reversed' entry (a storno/correction left
    // the pointer behind). The UI shows it as "utan koppling"; the guard must
    // agree and let it be linked to another posted verifikat.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: 'je-reversed', amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({ data: { status: 'reversed' }, error: null }) // hasLiveJournalEntryLink: stale link
    enqueue({
      data: { id: JE_UUID, status: 'posted', voucher_series: 'A', voucher_number: 12, entry_date: '2026-05-15' },
      error: null,
    }) // target JE fetch
    enqueue({ data: [{ id: TX_UUID }], error: null }) // tx UPDATE (overwrites the stale pointer)
    enqueue({ data: null, error: null }) // logMatchEvent insert
    enqueue({ data: null, error: null }) // dispatcher commit update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      transaction_id: TX_UUID,
      journal_entry_id: JE_UUID,
      voucher_label: 'A-12',
    })
  })

  it('returns 400 when JE is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'draft',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/posted/i)
  })

  it('happy path: links tx without invoice, no new bookkeeping created', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 12,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({ data: [{ id: TX_UUID }], error: null }) // tx UPDATE
    enqueue({ data: null, error: null }) // logMatchEvent insert
    enqueue({ data: null, error: null }) // dispatcher commit update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      transaction_id: TX_UUID,
      journal_entry_id: JE_UUID,
      voucher_label: 'A-12',
      invoice_id: null,
      invoice_status: null,
    })
  })

  it('happy path with invoice: links tx, flips invoice to paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
        currency: 'SEK',
      }),
      error: null,
    })
    enqueue({ data: [{ id: TX_UUID }], error: null }) // tx UPDATE
    enqueue({ data: [{ id: INV_UUID }], error: null }) // optimistic-lock invoice UPDATE
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments INSERT
    enqueue({ data: null, error: null }) // logMatchEvent insert
    enqueue({ data: null, error: null }) // dispatcher commit update

    const op = makePendingOp({
      params: {
        transaction_id: TX_UUID,
        journal_entry_id: JE_UUID,
        invoice_id: INV_UUID,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_id: INV_UUID,
      invoice_status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
    })
  })

  it('rejects a credit note before linking the transaction', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000 }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({
        id: INV_UUID,
        status: 'sent',
        total: -1000,
        remaining_amount: -1000,
        credited_invoice_id: 'original-invoice-1',
      }),
      error: null,
    })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        transaction_id: TX_UUID,
        journal_entry_id: JE_UUID,
        invoice_id: INV_UUID,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toBe('Credit notes cannot be recorded as paid.')
  })

  it('surfaces the database reason and code when the transaction UPDATE fails (LINK_TX_DB_ERROR)', async () => {
    // A customer hit LINK_TX_DB_ERROR reproducibly on certain incoming
    // payments and could not tell us why: the Postgres message was logged
    // but dropped on the way to the approver. The dispatcher must carry the
    // reason, the structured code and the details through.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 313, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 12,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    const pgMessage =
      'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"'
    enqueue({ data: null, error: { message: pgMessage, code: '23514' } }) // tx UPDATE fails
    enqueue({ data: null, error: null }) // dispatcher's reject/fail update

    const op = makePendingOp({
      params: { transaction_id: TX_UUID, journal_entry_id: JE_UUID },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.code).toBe('LINK_TX_DB_ERROR')
    expect(result.error).toContain(pgMessage)
    expect(result.data).toMatchObject({ reason: pgMessage })
  })

  it('returns 409 LINK_TX_INVOICE_RACE when optimistic lock loses', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: makeTransaction({ id: TX_UUID, journal_entry_id: null, amount: 1000, date: '2026-05-15' }),
      error: null,
    })
    enqueue({
      data: {
        id: JE_UUID,
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 1,
        entry_date: '2026-05-15',
      },
      error: null,
    })
    enqueue({
      data: makeInvoice({ id: INV_UUID, status: 'sent', total: 1000, remaining_amount: 1000 }),
      error: null,
    })
    enqueue({ data: [{ id: TX_UUID }], error: null }) // tx UPDATE succeeds
    enqueue({ data: [], error: null }) // optimistic invoice UPDATE returns 0 rows
    enqueue({ data: null, error: null }) // compensating rollback restores tx
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      params: {
        transaction_id: TX_UUID,
        journal_entry_id: JE_UUID,
        invoice_id: INV_UUID,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 409 is auto-rejected by the dispatcher (a fresh stage with the latest
    // invoice state will succeed if the racing payer didn't already settle).
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})
