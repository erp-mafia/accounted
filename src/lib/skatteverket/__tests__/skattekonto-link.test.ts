import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  entrySettlesAmount,
  groupSettlesEntry,
  linkSkattekontoRow,
  linkSkattekontoRows,
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

describe('groupSettlesEntry', () => {
  const l = (debit: number, credit: number, account = '1630') => ({ account_number: account, debit_amount: debit, credit_amount: credit })

  it('delegates a single row to entrySettlesAmount', () => {
    expect(groupSettlesEntry([l(0, 5000)], [-5000])).toEqual({ ok: true, via: 'line' })
  })
  it('settles a combined line by the exact sum, never within a tolerance', () => {
    expect(groupSettlesEntry([l(0, 12225), l(4521, 0, '2710'), l(7704, 0, '2731')], [-4521, -7704])).toEqual({ ok: true, via: 'line' })
    expect(groupSettlesEntry([l(0, 12225)], [-4521, -7703.99]).ok).toBe(false)
    expect(groupSettlesEntry([l(0, 12225)], [4521, 7704]).ok).toBe(false)
  })
  it('maps a net-zero pair onto one line each, only when every 1630 line is covered', () => {
    expect(groupSettlesEntry([l(10000, 0), l(0, 10000)], [10000, -10000])).toEqual({ ok: true, via: 'lines' })
    expect(groupSettlesEntry([l(10000, 0), l(0, 10000), l(0, 50)], [10000, -10000]).ok).toBe(false)
    expect(groupSettlesEntry([l(10000, 0), l(0, 9000)], [10000, -10000]).ok).toBe(false)
  })
  it('maps several rows onto several lines (a combined AGI line plus a payment)', () => {
    expect(groupSettlesEntry([l(12225, 0), l(0, 12225)], [12225, -4521, -7704])).toEqual({ ok: true, via: 'lines' })
  })
  it('rejects an empty group and rows with an unreadable amount', () => {
    expect(groupSettlesEntry([l(5000, 0)], []).ok).toBe(false)
    expect(groupSettlesEntry([l(5000, 0)], [Number.NaN, 5000]).ok).toBe(false)
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

  it('refuses an entry already linked by another row when the group no longer settles it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row() })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: [{ id: 'row-9', belopp_skatteverket: 5000 }] })
    await expect(linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)).rejects.toMatchObject({ code: 'ENTRY_ALREADY_LINKED' })
  })

  it('links the second event of a payment + debit voucher already linked to the first (crm#104)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row({ belopp_skatteverket: -10000 }) })
    enqueue({
      data: entry([
        { account_number: '1630', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1630', debit_amount: 0, credit_amount: 10000 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
        { account_number: '2518', debit_amount: 10000, credit_amount: 0 },
      ]),
    })
    enqueue({ data: [{ id: 'row-payment', belopp_skatteverket: 10000 }] })
    enqueue({ data: [{ id: ROW }] })
    const result = await linkSkattekontoRow(supabase as never, COMPANY, ROW, ENTRY)
    expect(result).toEqual({ skattekonto_transaction_id: ROW, journal_entry_id: ENTRY, via: 'lines' })
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

describe('linkSkattekontoRows (N:1)', () => {
  const ROW2 = 'row-2'
  const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('links a group whose sum the verifikat settles, with one guarded update over all rows', async () => {
    enqueue({ data: [row({ belopp_skatteverket: 3000 }), row({ id: ROW2, belopp_skatteverket: 2000 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: [] }) // nothing outside the group linked to the entry
    enqueue({ data: [{ id: ROW }, { id: ROW2 }] })
    const result = await linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2, ROW], ENTRY)
    expect(result).toEqual({ journal_entry_id: ENTRY, via: 'line', skattekonto_transaction_ids: [ROW, ROW2] })
    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ journal_entry_id: ENTRY, suggested_journal_entry_id: null })
  })

  it('refuses a group where a row is already linked, ignored or upcoming', async () => {
    enqueue({ data: [row(), row({ id: ROW2, journal_entry_id: 'other' })] })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'ALREADY_BOOKED' })
    reset()
    enqueue({ data: [row(), row({ id: ROW2, is_ignored: true })] })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'ROW_IGNORED' })
    reset()
    enqueue({ data: [row(), row({ id: ROW2, status: 'upcoming' })] })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
  })

  it('refuses when the sum does not settle the verifikat, or a net-zero pair has no line of its own', async () => {
    enqueue({ data: [row({ belopp_skatteverket: 3000 }), row({ id: ROW2, belopp_skatteverket: 2000 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 4999, credit_amount: 0 }]) })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
    reset()
    enqueue({ data: [row({ belopp_skatteverket: 3000 }), row({ id: ROW2, belopp_skatteverket: -3000 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 3000, credit_amount: 0 }]) })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
  })

  it('links a net-zero pair when each row matches its own 1630 line in the voucher (crm#104)', async () => {
    enqueue({ data: [row({ belopp_skatteverket: 10000 }), row({ id: ROW2, belopp_skatteverket: -10000 })] })
    enqueue({
      data: entry([
        { account_number: '1630', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
        { account_number: '1630', debit_amount: 0, credit_amount: 10000 },
        { account_number: '2518', debit_amount: 10000, credit_amount: 0 },
      ]),
    })
    enqueue({ data: [] })
    enqueue({ data: [{ id: ROW }, { id: ROW2 }] })
    const result = await linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)
    expect(result.via).toBe('lines')
  })

  it('links a combined AGI line: two same-day rows against one 1630 credit (crm#128)', async () => {
    enqueue({ data: [row({ belopp_skatteverket: -4521 }), row({ id: ROW2, belopp_skatteverket: -7704 })] })
    enqueue({
      data: entry([
        { account_number: '1630', debit_amount: 0, credit_amount: 12225 },
        { account_number: '2710', debit_amount: 4521, credit_amount: 0 },
        { account_number: '2731', debit_amount: 7704, credit_amount: 0 },
      ]),
    })
    enqueue({ data: [] })
    enqueue({ data: [{ id: ROW }, { id: ROW2 }] })
    const result = await linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)
    expect(result).toEqual({ journal_entry_id: ENTRY, via: 'line', skattekonto_transaction_ids: [ROW, ROW2] })
  })

  it('lets a group join rows already on the verifikat when all of them together settle it', async () => {
    enqueue({ data: [row({ belopp_skatteverket: -7704 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 0, credit_amount: 12225 }]) })
    enqueue({ data: [{ id: 'row-linked', belopp_skatteverket: -4521 }] })
    enqueue({ data: [{ id: ROW }] })
    const result = await linkSkattekontoRows(supabase as never, COMPANY, [ROW], ENTRY)
    expect(result.via).toBe('line')
  })

  it('refuses a verifikat already linked to a row outside the group', async () => {
    enqueue({ data: [row({ belopp_skatteverket: 3000 }), row({ id: ROW2, belopp_skatteverket: 2000 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: [{ id: 'row-elsewhere' }] })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'ENTRY_ALREADY_LINKED' })
  })

  it('rolls a partial hit back and reports LINK_RACE', async () => {
    enqueue({ data: [row({ belopp_skatteverket: 3000 }), row({ id: ROW2, belopp_skatteverket: 2000 })] })
    enqueue({ data: entry([{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }]) })
    enqueue({ data: [] })
    enqueue({ data: [{ id: ROW }] }) // only one of two rows was still free
    enqueue({ data: null }) // the revert
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'LINK_RACE' })
    const updates = findCalls('skattekonto_transactions', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1][0]).toEqual({ journal_entry_id: null })
  })

  it('refuses a missing row and an empty selection', async () => {
    enqueue({ data: [row()] })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [ROW, ROW2], ENTRY)).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' })
    await expect(linkSkattekontoRows(supabase as never, COMPANY, [], ENTRY)).rejects.toBeInstanceOf(SkattekontoLinkError)
  })
})
