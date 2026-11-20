/**
 * The verifikat line insert under the company's busy lock (for #206).
 *
 * lock_cash_history_for_journal_line refuses the insert with
 * CASH_ACCOUNT_OPERATION_BUSY while another booking of the same company is
 * being numbered, so five parallel bookings of one batch refused each other.
 * The engine tries the same insert again on the shared bounded waits
 * (cash-account-busy.ts): the header is written once, the draft is cancelled
 * only when the waits run out, and the caller then gets the original refusal.
 * That a refused insert leaves no line behind is proven against real Postgres
 * in tests/pg/journal-line-insert-busy-leaves-nothing.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

import { createDraftEntry, updateDraftEntry } from '../engine'
import { CASH_ACCOUNT_BUSY_RETRY, isCashAccountBusy } from '../cash-account-busy'
import { BookkeepingDatabaseError } from '../errors'

const BUSY = { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY', details: null, hint: null }
const OK = { data: null, error: null }

const READS: Record<string, unknown> = {
  fiscal_periods: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  chart_of_accounts: [
    { account_number: '1930', id: 'acc-1930' },
    { account_number: '4010', id: 'acc-4010' },
  ],
  journal_entries: { id: 'entry-1', status: 'draft', voucher_series: 'A', lines: [] },
}

/** Every read answers from READS; the line inserts answer from `lineInsertOutcomes`, in order. */
function buildSupabase(lineInsertOutcomes: Array<{ data: null; error: unknown }>) {
  const lineInserts: unknown[] = []
  const headerInserts: unknown[] = []
  const headerUpdates: unknown[] = []
  const from = vi.fn((table: string) => {
    const resolved = { data: READS[table] ?? null, error: null }
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'delete', 'order', 'limit']) {
      chain[method] = () => chain
    }
    chain.single = () => Promise.resolve(resolved)
    chain.maybeSingle = () => Promise.resolve(resolved)
    chain.then = (resolve: (value: unknown) => void) => resolve(resolved)
    chain.update = (payload: unknown) => {
      if (table === 'journal_entries') headerUpdates.push(payload)
      return chain
    }
    chain.insert = (payload: unknown) => {
      if (table !== 'journal_entry_lines') {
        headerInserts.push(payload)
        return chain
      }
      lineInserts.push(payload)
      return Promise.resolve(lineInsertOutcomes[lineInserts.length - 1] ?? OK)
    }
    return chain
  })
  return { supabase: { from, rpc: vi.fn() }, lineInserts, headerInserts, headerUpdates }
}

const INPUT: CreateJournalEntryInput = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-06-15',
  description: 'Bank row',
  source_type: 'bank_transaction',
  // Explicit, so the series is not read from company_settings.
  voucher_series: 'A',
  lines: [
    { account_number: '4010', debit_amount: 100, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 100 },
  ],
}

const realDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs

beforeEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = [0, 0, 0, 0]
})
afterEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = realDelays
})

describe('createDraftEntry: the line insert under the busy lock', () => {
  it('tries the same insert again and keeps the one draft header', async () => {
    const { supabase, lineInserts, headerInserts, headerUpdates } = buildSupabase([
      { data: null, error: BUSY },
      { data: null, error: BUSY },
      OK,
    ])

    const entry = await createDraftEntry(supabase as never, 'company-1', 'user-1', INPUT)

    expect(entry.id).toBe('entry-1')
    expect(lineInserts).toHaveLength(3)
    // The very same rows each time, under the one header.
    expect(lineInserts[1]).toEqual(lineInserts[0])
    expect(lineInserts[2]).toEqual(lineInserts[0])
    expect(headerInserts).toHaveLength(1)
    // Never cancelled on the way.
    expect(headerUpdates).toEqual([])
  })

  it('gives up after the bounded waits with the original refusal and cancels the draft', async () => {
    const { supabase, lineInserts, headerInserts, headerUpdates } = buildSupabase(
      Array.from({ length: 10 }, () => ({ data: null, error: BUSY })),
    )

    const failure = await createDraftEntry(supabase as never, 'company-1', 'user-1', INPUT).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(BookkeepingDatabaseError)
    expect(isCashAccountBusy(failure)).toBe(true)
    expect((failure as BookkeepingDatabaseError).pgCode).toBe('PT409')
    // The first try plus one per configured wait, no more.
    expect(lineInserts).toHaveLength(1 + CASH_ACCOUNT_BUSY_RETRY.delaysMs.length)
    expect(headerInserts).toHaveLength(1)
    expect(headerUpdates).toEqual([{ status: 'cancelled' }])
  })

  it('does not try again for any other refusal', async () => {
    const { supabase, lineInserts, headerUpdates } = buildSupabase([
      { data: null, error: { code: '23514', message: 'check constraint', details: null, hint: null } },
    ])

    await expect(createDraftEntry(supabase as never, 'company-1', 'user-1', INPUT)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )

    expect(lineInserts).toHaveLength(1)
    expect(headerUpdates).toEqual([{ status: 'cancelled' }])
  })
})

describe('updateDraftEntry: the line insert under the busy lock', () => {
  it('tries the insert again, so a busy moment does not leave the draft without lines', async () => {
    const { supabase, lineInserts } = buildSupabase([{ data: null, error: BUSY }, OK])

    const entry = await updateDraftEntry(supabase as never, 'company-1', 'user-1', 'entry-1', INPUT)

    expect(entry.id).toBe('entry-1')
    expect(lineInserts).toHaveLength(2)
    expect(lineInserts[1]).toEqual(lineInserts[0])
  })
})
