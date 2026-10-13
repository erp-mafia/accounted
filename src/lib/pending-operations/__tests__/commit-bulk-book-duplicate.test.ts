/**
 * The approval of a bulk_book_transactions op runs the operation
 * transactions.bulk-book, which runs the booking-time duplicate guard every
 * bulk-book door runs (runBulkBookDuplicateGuard) before the RPC. Staging
 * already ran it, but another verifikat can book the same bank line between
 * staging and approval, and the RPC only refuses a row that already has a
 * verifikat of its own. The ops are staged in the hand-written tool's shape
 * (allow_duplicate), which upgradeParams rewrites to force.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'

import { commitPendingOperation } from '../commit'

vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()
  return { ...actual, detectBookingDuplicate: vi.fn() }
})
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn(async () => undefined),
}))
// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

function makeBulkBookOp(params: Record<string, unknown> = {}): PendingOperation {
  return {
    id: 'op-bulk-dup',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    title: 'Länka 1 transaktioner -1 250,00 SEK 2026-05-12 till verifikat: BG 5050-1055',
    params: { tx_ids: [TX], existing_journal_entry_id: JE, new_entry: null, ...params },
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'agent',
    risk_level: 'high',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-05-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-12T00:00:00Z',
  }
}

const TX = '11111111-1111-4111-8111-111111111111'
const JE = '33333333-3333-4333-8333-333333333333'

const ROW = {
  id: TX,
  description: 'BG 5050-1055',
  journal_entry_id: null,
  amount: -1250,
  currency: 'SEK',
  date: '2026-05-12',
  amount_sek: null,
  exchange_rate: null,
  cash_account_id: null,
}

const CANDIDATE: BookedDuplicateCandidate = {
  transaction_id: null,
  journal_entry_id: 'je-paid',
  voucher_label: 'A142',
  entry_date: '2026-05-12',
  description: 'Leverantörsfaktura betald',
  amount: 1250,
  account_number: '1930',
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
}

describe('commitPendingOperation(bulk_book_transactions): duplicate guard at approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('refuses with TRANSACTION_BOOK_POSSIBLE_DUPLICATE before the RPC', async () => {
    vi.mocked(detectBookingDuplicate).mockResolvedValueOnce(CANDIDATE)
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-dup' }, error: null }, // atomic claim pending -> committing
      { data: [ROW], error: null }, // transactions
      { data: null, error: null }, // dispatcher: rejected update
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeBulkBookOp())

    // 409 consumes the op, like a vanished or already-booked row: the agent
    // re-stages with force after the user has reviewed the candidate.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(result.error).toContain('verifikat A142')
    expect(detectBookingDuplicate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ id: TX, amount: -1250 }),
      { excludeTransactionIds: [TX], excludeJournalEntryIds: [JE] },
    )
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('books with the staged allow_duplicate and records the dismissal', async () => {
    vi.mocked(detectBookingDuplicate).mockResolvedValueOnce(CANDIDATE)
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-dup' }, error: null },
      { data: [ROW], error: null }, // transactions
      { data: { ok: true, journal_entry_id: JE, mode: 'link_existing', linked_tx_count: 1 }, error: null }, // RPC
      { data: [], error: null }, // transaction.reconciled: the booked rows re-read
      { data: null, error: null }, // finalize committed
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeBulkBookOp({ allow_duplicate: true }),
    )

    expect(result.status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledWith('bulk_book_transactions', expect.anything())
    // What the dashboard and v1 bookings did and the hand-written executor
    // skipped: a matched underlag completes against the samlingsverifikat.
    expect(propagateUnderlagForBookedTransaction).toHaveBeenCalledWith(supabase, 'company-1', TX, JE)
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        aggregateId: TX,
        // The operation's label: an approved staged force is a machine-door
        // write, recorded like v1's (the actor stays the approving user).
        payload: expect.objectContaining({ dismissed_journal_entry_id: 'je-paid', via: 'api_force' }),
        actor: { type: 'user', id: 'user-1' },
      }),
    )
  })
})
