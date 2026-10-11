/**
 * commitBulkBooking(): the engine door to bulk_book_transactions. The RPC
 * creates and commits a samlingsverifikat in SQL, outside commitEntry, so this
 * door is what announces it with journal_entry.committed (the event webhook
 * subscribers and the event log listen to). Before it existed, every bulk
 * booking posted a voucher nobody heard about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const emit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

const { commitBulkBooking } = await import('../engine')

type Result = { data?: unknown; error?: unknown }

const POSTED = {
  id: 'je-1',
  company_id: 'co',
  status: 'posted',
  voucher_series: 'A',
  voucher_number: 13,
  lines: [
    { account_number: '1930', debit_amount: 300, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 300 },
  ],
}

const NEW_ENTRY = {
  description: 'Swish 2026-06-05',
  lines: [
    { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'SEK' },
    { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'SEK' },
  ],
}

function makeSupabase(rpc: Result, reload: Result = { data: POSTED }) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: reload.data ?? null, error: reload.error ?? null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table)
          }
        },
      },
    )
  const rpcFn = vi.fn().mockResolvedValue({ data: rpc.data ?? null, error: rpc.error ?? null })
  const supabase = { rpc: rpcFn, from: vi.fn((table: string) => chain(table)) }
  return { supabase: supabase as never, rpc: rpcFn, calls }
}

const CREATED = {
  ok: true,
  mode: 'create_new',
  journal_entry_id: 'je-1',
  voucher_series: 'A',
  voucher_number: 13,
  linked_tx_count: 2,
  tx_sum: 300,
  docs_linked: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitBulkBooking', () => {
  it('a new samlingsverifikat emits journal_entry.committed with the posted entry, as commitEntry does', async () => {
    const { supabase, rpc, calls } = makeSupabase({ data: CREATED })

    const result = await commitBulkBooking(supabase, 'co', 'user-1', {
      txIds: ['tx-1', 'tx-2'],
      existingJournalEntryId: null,
      newEntry: NEW_ENTRY,
    })

    expect(result).toEqual({ data: CREATED, error: null })
    expect(rpc).toHaveBeenCalledWith('bulk_book_transactions', {
      p_tx_ids: ['tx-1', 'tx-2'],
      p_existing_journal_entry_id: null,
      p_new_entry: NEW_ENTRY,
      p_company_id: 'co',
      p_user_id: 'user-1',
      // No actor scope in this test: nothing to attribute.
      p_commit_method: null,
      p_actor_type: null,
      p_actor_label: null,
    })
    // The reload is scoped to the entry AND the company.
    const reload = calls.filter((c) => c.table === 'journal_entries')
    expect(reload.find((c) => c.method === 'select')?.args).toEqual(['*, lines:journal_entry_lines(*)'])
    expect(reload.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['id', 'je-1'],
      ['company_id', 'co'],
    ])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      type: 'journal_entry.committed',
      payload: { entry: POSTED, userId: 'user-1', companyId: 'co' },
    })
  })

  it('link_existing posts nothing new and emits nothing', async () => {
    const linked = { ...CREATED, mode: 'link_existing', voucher_number: 7 }
    const { supabase, calls } = makeSupabase({ data: linked })

    const result = await commitBulkBooking(supabase, 'co', 'user-1', {
      txIds: ['tx-1'],
      existingJournalEntryId: 'je-1',
      newEntry: null,
    })

    expect(result).toEqual({ data: linked, error: null })
    expect(calls).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a structured refusal is returned unchanged and emits nothing', async () => {
    const refused = { ok: false, code: 'BULK_BOOK_PERIOD_LOCKED' }
    const { supabase } = makeSupabase({ data: refused })

    const result = await commitBulkBooking(supabase, 'co', 'user-1', {
      txIds: ['tx-1'],
      existingJournalEntryId: null,
      newEntry: NEW_ENTRY,
    })

    expect(result).toEqual({ data: refused, error: null })
    expect(emit).not.toHaveBeenCalled()
  })

  it('a transport error is returned unchanged and emits nothing', async () => {
    const pgError = { message: 'connection reset', code: '08006' }
    const { supabase } = makeSupabase({ error: pgError })

    const result = await commitBulkBooking(supabase, 'co', 'user-1', {
      txIds: ['tx-1'],
      existingJournalEntryId: null,
      newEntry: NEW_ENTRY,
    })

    expect(result.error).toEqual(pgError)
    expect(emit).not.toHaveBeenCalled()
  })

  it('a failed reload after the commit still answers the booking, without the event', async () => {
    const { supabase } = makeSupabase({ data: CREATED }, { error: { message: 'timeout' } })

    const result = await commitBulkBooking(supabase, 'co', 'user-1', {
      txIds: ['tx-1', 'tx-2'],
      existingJournalEntryId: null,
      newEntry: NEW_ENTRY,
    })

    expect(result).toEqual({ data: CREATED, error: null })
    expect(emit).not.toHaveBeenCalled()
  })
})
