import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  entrySettlesAmount,
  linkSkattekontoRow,
  setSkattekontoRowIgnored,
  SkattekontoLinkError,
  unlinkSkattekontoRow,
} from '../skattekonto-link'

const COMPANY = 'company-1'
const ROW = 'row-1'
const ENTRY = 'entry-1'

function row(overrides: Record<string, unknown> = {}) {
  return { id: ROW, belopp_skatteverket: 5000, journal_entry_id: null, is_ignored: false, status: 'booked', ...overrides }
}
function entry(lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>, status = 'posted') {
  return { id: ENTRY, status, lines }
}

describe('entrySettlesAmount', () => {
  it('matches a single line on the expected side', () => {
    expect(entrySettlesAmount([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }], 5000)).toEqual({ ok: true, via: 'line' })
    expect(entrySettlesAmount([{ account_number: '1630', debit_amount: 0, credit_amount: 5447 }], -5447)).toEqual({ ok: true, via: 'line' })
  })
  it('falls back to the entry net over several 1630 lines', () => {
    expect(
      entrySettlesAmount(
        [
          { account_number: '1630', debit_amount: 3000, credit_amount: 0 },
          { account_number: '1630', debit_amount: 2000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 5000 },
        ],
        5000,
      ),
    ).toEqual({ ok: true, via: 'entry_total' })
  })
  it('rejects the wrong side, a different amount, and entries without 1630 lines', () => {
    expect(entrySettlesAmount([{ account_number: '1630', debit_amount: 0, credit_amount: 5000 }], 5000).ok).toBe(false)
    expect(entrySettlesAmount([{ account_number: '1630', debit_amount: 4999, credit_amount: 0 }], 5000).ok).toBe(false)
    expect(entrySettlesAmount([{ account_number: '1930', debit_amount: 5000, credit_amount: 0 }], 5000).ok).toBe(false)
  })
})

describe('linkSkattekontoRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links an open row to a posted entry with a matching 1630 line and clears the proposal', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: row() })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: null }) // already-linked check
    enqueue({ data: [{ id: ROW }] }) // update … select

    const result = await linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)

    expect(result).toEqual({ skattekonto_transaction_id: ROW, journal_entry_id: ENTRY, via: 'line' })
    expect(findCalls('skattekonto_transactions', 'update')[0][0]).toEqual({
      journal_entry_id: ENTRY,
      suggested_journal_entry_id: null,
      suggested_at: null,
    })
    expect(findCalls('skattekonto_transactions', 'is')).toContainEqual(['journal_entry_id', null])
  })

  it.each([
    ['TRANSACTION_NOT_FOUND', null, undefined],
    ['ALREADY_BOOKED', row({ journal_entry_id: 'other' }), undefined],
    ['ROW_IGNORED', row({ is_ignored: true }), undefined],
    ['INVALID_CANDIDATE', row({ status: 'upcoming' }), undefined],
    ['ENTRY_NOT_FOUND', row(), null],
    ['INVALID_CANDIDATE', row(), entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }], 'reversed')],
    ['INVALID_CANDIDATE', row(), entry([{ account_number: '1630', debit_amount: 4000, credit_amount: 0 }])],
  ])('refuses with %s', async (code, rowData, entryData) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rowData })
    if (entryData !== undefined) enqueue({ data: entryData })
    await expect(linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)).rejects.toMatchObject({ code })
  })

  it('refuses an entry already linked by another row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row() })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: { id: 'row-9' } })
    await expect(linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)).rejects.toMatchObject({ code: 'ENTRY_ALREADY_LINKED' })
  })

  it('reports a lost race when the guarded update touches no row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row() })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: null })
    enqueue({ data: [] })
    await expect(linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)).rejects.toMatchObject({ code: 'LINK_RACE' })
  })
})

describe('unlinkSkattekontoRow / setSkattekontoRowIgnored', () => {
  it('clears the pointer and reports the previous entry', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: ROW, journal_entry_id: ENTRY } })
    enqueue({ data: null })
    const result = await unlinkSkattekontoRow(supabase as never, COMPANY, ROW)
    expect(result).toEqual({ skattekonto_transaction_id: ROW, previous_journal_entry_id: ENTRY })
    expect(findCalls('skattekonto_transactions', 'update')[0][0]).toEqual({ journal_entry_id: null })
  })

  it('refuses to unlink an unlinked row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: ROW, journal_entry_id: null } })
    await expect(unlinkSkattekontoRow(supabase as never, COMPANY, ROW)).rejects.toBeInstanceOf(SkattekontoLinkError)
  })

  it('refuses to ignore a linked row and is a no-op when already in the requested state', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: ROW, journal_entry_id: ENTRY, is_ignored: false } })
    await expect(setSkattekontoRowIgnored(supabase as never, COMPANY, ROW, true)).rejects.toMatchObject({ code: 'ALREADY_BOOKED' })
    enqueue({ data: { id: ROW, journal_entry_id: null, is_ignored: true } })
    expect(await setSkattekontoRowIgnored(supabase as never, COMPANY, ROW, true)).toEqual({ skattekonto_transaction_id: ROW, is_ignored: true })
    expect(findCalls('skattekonto_transactions', 'update')).toHaveLength(0)
  })

  it('ignoring clears the proposal too', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: ROW, journal_entry_id: null, is_ignored: false } })
    enqueue({ data: null })
    await setSkattekontoRowIgnored(supabase as never, COMPANY, ROW, true)
    expect(findCalls('skattekonto_transactions', 'update')[0][0]).toEqual({
      is_ignored: true,
      suggested_journal_entry_id: null,
      suggested_at: null,
    })
  })
})
