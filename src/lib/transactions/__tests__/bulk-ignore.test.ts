/**
 * Bulk ignore before a cutoff (crm#1647): the selection a staged
 * gnubok_bulk_ignore_transactions pins, and the commit that re-applies it.
 *
 * Pins: an ignore reads open work only (open_bank_rows, no pointer, no
 * invoice link) on one cash account strictly before the date; a restore
 * reads ignored rows; the cap answers a split date; the commit writes only
 * the pinned rows that still match, with the guards repeated on the write,
 * in chunks; database failures throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { applyBulkIgnore, BULK_IGNORE_MAX_ROWS, findBulkIgnoreCandidates } from '../bulk-ignore'

const CASH = '00000000-0000-4000-8000-0000000000ca'
const ignoreSel = { cashAccountId: CASH, beforeDate: '2026-01-01', ignored: true }
const restoreSel = { ...ignoreSel, ignored: false }

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findBulkIgnoreCandidates', () => {
  it('reads open rows of the one cash account strictly before the date, with no pointer and no invoice link', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: id(1), date: '2024-03-02' },
        { id: id(2), date: '2025-12-30' },
      ],
      count: 2,
    })

    const found = await findBulkIgnoreCandidates(supabase as never, 'company-1', ignoreSel)

    expect(found).toEqual({ ids: [id(1), id(2)], total: 2, first_date: '2024-03-02', last_date: '2025-12-30', split_before: null })
    expect(findCalls('open_bank_rows', 'select')).toEqual([['id, date', { count: 'exact' }]])
    expect(findCalls('open_bank_rows', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['cash_account_id', CASH],
    ])
    expect(findCalls('open_bank_rows', 'lt')).toEqual([['date', '2026-01-01']])
    expect(findCalls('open_bank_rows', 'is')).toEqual([
      ['journal_entry_id', null],
      ['invoice_id', null],
      ['supplier_invoice_id', null],
    ])
    expect(findCalls('open_bank_rows', 'range')).toEqual([[0, BULK_IGNORE_MAX_ROWS]])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('a restore reads the ignored rows of the account before the date', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: id(1), date: '2025-01-05' }], count: 1 })

    const found = await findBulkIgnoreCandidates(supabase as never, 'company-1', restoreSel)

    expect(found.ids).toEqual([id(1)])
    expect(findCalls('open_bank_rows', 'select')).toEqual([])
    expect(findCalls('transactions', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['cash_account_id', CASH],
      ['is_ignored', true],
    ])
    expect(findCalls('transactions', 'is')).toEqual([])
  })

  it('past the cap: keeps the oldest rows and names the date of the first row past it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = Array.from({ length: BULK_IGNORE_MAX_ROWS + 1 }, (_, i) => ({
      id: id(i + 1),
      date: i < BULK_IGNORE_MAX_ROWS ? '2024-06-01' : '2024-09-15',
    }))
    enqueue({ data: rows, count: 812 })

    const found = await findBulkIgnoreCandidates(supabase as never, 'company-1', ignoreSel)

    expect(found.ids).toHaveLength(BULK_IGNORE_MAX_ROWS)
    expect(found.total).toBe(812)
    expect(found.split_before).toBe('2024-09-15')
  })

  it('past the cap within one day: no split date to offer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = Array.from({ length: BULK_IGNORE_MAX_ROWS + 1 }, (_, i) => ({ id: id(i + 1), date: '2024-06-01' }))
    enqueue({ data: rows, count: BULK_IGNORE_MAX_ROWS + 1 })

    const found = await findBulkIgnoreCandidates(supabase as never, 'company-1', ignoreSel)

    expect(found.total).toBe(BULK_IGNORE_MAX_ROWS + 1)
    expect(found.split_before).toBeNull()
  })

  it('nothing matches: an empty set', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], count: 0 })

    const found = await findBulkIgnoreCandidates(supabase as never, 'company-1', ignoreSel)

    expect(found).toEqual({ ids: [], total: 0, first_date: null, last_date: null, split_before: null })
  })

  it('throws with the SQLSTATE when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'db down', code: '57P01' } })

    await expect(findBulkIgnoreCandidates(supabase as never, 'company-1', ignoreSel)).rejects.toMatchObject({
      message: 'db down',
      code: '57P01',
    })
  })
})

describe('applyBulkIgnore', () => {
  it('ignores only the pinned rows that are still open, with the guards repeated on the write', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: id(1) }, { id: id(3) }] }) // re-read: row 2 was booked since staging
    enqueue({ data: [{ id: id(1) }, { id: id(3) }] }) // update ... select

    const outcome = await applyBulkIgnore(supabase as never, 'company-1', ignoreSel, [id(1), id(2), id(3)])

    expect(outcome).toEqual({ changed: 2, skipped: 1 })
    expect(findCalls('open_bank_rows', 'in')).toEqual([['id', [id(1), id(2), id(3)]]])
    expect(findCalls('open_bank_rows', 'lt')).toEqual([['date', '2026-01-01']])
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: true }]])
    expect(findCalls('transactions', 'in')).toEqual([['id', [id(1), id(3)]]])
    expect(findCalls('transactions', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_ignored', false],
    ])
    expect(findCalls('transactions', 'is')).toEqual([['journal_entry_id', null]])
  })

  it('writes nothing when no pinned row still matches', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    const outcome = await applyBulkIgnore(supabase as never, 'company-1', ignoreSel, [id(1)])

    expect(outcome).toEqual({ changed: 0, skipped: 1 })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restores ignored rows, without the pointer guard', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: id(1) }] })
    enqueue({ data: [{ id: id(1) }] })

    const outcome = await applyBulkIgnore(supabase as never, 'company-1', restoreSel, [id(1)])

    expect(outcome).toEqual({ changed: 1, skipped: 0 })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: false }]])
    expect(findCalls('transactions', 'is')).toEqual([])
    expect(findCalls('open_bank_rows', 'select')).toEqual([])
  })

  it('works in chunks of 100 ids and drops duplicates', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const ids = Array.from({ length: 250 }, (_, i) => id(i + 1))
    for (const part of [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)]) {
      enqueue({ data: part.map((x) => ({ id: x })) })
      enqueue({ data: part.map((x) => ({ id: x })) })
    }

    const outcome = await applyBulkIgnore(supabase as never, 'company-1', ignoreSel, [...ids, ids[0]!])

    expect(outcome).toEqual({ changed: 250, skipped: 0 })
    expect(findCalls('open_bank_rows', 'in').map(([, part]) => (part as string[]).length)).toEqual([100, 100, 50])
    expect(findCalls('transactions', 'update')).toHaveLength(3)
  })

  it('throws with the SQLSTATE when the write fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: id(1) }] })
    enqueue({ error: { message: 'locked', code: '55P03' } })

    await expect(applyBulkIgnore(supabase as never, 'company-1', ignoreSel, [id(1)])).rejects.toMatchObject({
      message: 'locked',
      code: '55P03',
    })
  })
})
