/**
 * The period lock on a staged operation (crm#1923): which operations are
 * judged, what the stager is told, and what the approval queue is handed.
 * A voucher dated in a locked period used to stage with nothing but
 * period_status in the envelope, and wait in the queue looking approvable.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PeriodLockForDate } from '@/lib/core/bookkeeping/period-status'
import { stagedPeriodLock, stagedPeriodLockNote, stagedPostingDate, withPeriodLocks } from '../period-lock'

const COMPANY = 'company-1'

const voucher = (entryDate: unknown) => ({
  id: 'op-voucher',
  operation_type: 'create_voucher',
  params: { entry_date: entryDate, description: 'Periodisering' },
  preview_data: { entry_date: entryDate, total_debit: 1000 },
})
const categorization = (date: unknown) => ({
  id: 'op-categorize',
  operation_type: 'categorize_transaction',
  params: { transaction_id: 'tx-1' },
  preview_data: { date, debit_account: '6110' },
})

const BEHIND_LOCK_DATE: PeriodLockForDate = {
  status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-10-31' },
  layer: 'company_lock_date',
}
const YEAR_LOCKED: PeriodLockForDate = {
  status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-11-10T09:30:00Z' },
  layer: 'fiscal_period',
}
const YEAR_CLOSED: PeriodLockForDate = {
  status: { period_id: 'fp-2025', status: 'closed', lock_date: null },
  layer: 'fiscal_period',
}
const OPEN: PeriodLockForDate = { status: { period_id: 'fp-2026', status: 'open', lock_date: null }, layer: null }
const UNREAD: PeriodLockForDate = {
  status: { period_id: null, status: 'locked', lock_date: null, lookup_failed: true },
  layer: null,
}

describe('stagedPostingDate', () => {
  it('reads the date an approval posts on for the judged types', () => {
    expect(stagedPostingDate(voucher('2026-10-05'))).toBe('2026-10-05')
    expect(stagedPostingDate(categorization('2026-10-07'))).toBe('2026-10-07')
  })

  it('judges no other type, whatever dates its row carries: a lock there stops nothing', () => {
    for (const operation_type of ['create_invoice', 'submit_vat_declaration', 'ignore_transaction', 'unlock_period', 'toString']) {
      expect(
        stagedPostingDate({
          operation_type,
          params: { entry_date: '2026-10-05', invoice_date: '2026-10-05', period_end: '2026-10-31' },
          preview_data: { date: '2026-10-05' },
        }),
      ).toBeNull()
    }
  })

  it('answers null for a judged row without a readable date', () => {
    expect(stagedPostingDate(voucher(undefined))).toBeNull()
    expect(stagedPostingDate(voucher('5 oktober'))).toBeNull()
    expect(stagedPostingDate(voucher('2026-02-31'))).toBeNull()
    expect(stagedPostingDate({ operation_type: 'categorize_transaction', params: null, preview_data: null })).toBeNull()
  })
})

describe('stagedPeriodLock', () => {
  it('states the company lock date as the date the books are locked through', () => {
    expect(stagedPeriodLock('2026-10-05', BEHIND_LOCK_DATE)).toEqual({
      period_id: 'fp-2026',
      status: 'locked',
      lock_date: '2026-10-31',
      date: '2026-10-05',
    })
  })

  it("preserves the invoice date in lock guidance for a received self-bill", () => {
    const op = {
      operation_type: 'create_self_billed_invoice',
      params: { invoice_date: '2026-10-05' },
      preview_data: { posts_on_approval: true },
    }
    const note = stagedPeriodLockNote(op, '2026-10-05', BEHIND_LOCK_DATE)
    expect(note).toContain('retains its actual date')
    expect(note).not.toContain('stage it again')
    expect(stagedPostingDate({ ...op, preview_data: { posts_on_approval: false } })).toBeNull()
  })

  it("states no through-date for a year's own lock (its lock_date is when it was locked) or a closed year", () => {
    expect(stagedPeriodLock('2026-06-01', YEAR_LOCKED)).toEqual({
      period_id: 'fp-2026',
      status: 'locked',
      lock_date: null,
      date: '2026-06-01',
    })
    expect(stagedPeriodLock('2025-06-01', YEAR_CLOSED)).toMatchObject({ status: 'closed', lock_date: null })
  })

  it('is no stop for an open date, an unread lock or no verdict', () => {
    expect(stagedPeriodLock('2026-11-03', OPEN)).toBeNull()
    expect(stagedPeriodLock('2026-11-03', UNREAD)).toBeNull()
    expect(stagedPeriodLock('2026-11-03', undefined)).toBeNull()
  })
})

describe('stagedPeriodLockNote', () => {
  it('says the date is behind the company lock date, that approval is refused, and both ways on', () => {
    const note = stagedPeriodLockNote(voucher('2026-10-05'), '2026-10-05', BEHIND_LOCK_DATE)

    expect(note).toMatch(/^PERIOD LOCKED: 2026-10-05 is on or before the company lock date \(bookkeeping is locked through 2026-10-31\)/)
    expect(note).toContain('cannot be approved as it stands')
    expect(note).toContain('refused with PERIOD_LOCKED and nothing is booked')
    expect(note).toContain('a date in an open period')
    expect(note).toContain('gnubok_update_bookkeeping_lock')
  })

  it("names the year's own lock and where it is unlocked, without calling its lock time a through-date", () => {
    const note = stagedPeriodLockNote(voucher('2026-06-01'), '2026-06-01', YEAR_LOCKED)

    expect(note).toContain('2026-06-01 is in a locked fiscal year')
    expect(note).toContain('gnubok_unlock_period')
    expect(note).not.toContain('2026-11-10')
  })

  it('says a closed year is not unlocked', () => {
    const note = stagedPeriodLockNote(voucher('2025-06-01'), '2025-06-01', YEAR_CLOSED)

    expect(note).toMatch(/^PERIOD CLOSED: 2025-06-01/)
    expect(note).toContain('A closed year is not unlocked')
    expect(note).not.toContain('unlock_period')
  })

  it('says nothing for an open date, an unread lock, a type that is not judged, or a lock checked for another date', () => {
    expect(stagedPeriodLockNote(voucher('2026-11-03'), '2026-11-03', OPEN)).toBeNull()
    expect(stagedPeriodLockNote(voucher('2026-10-05'), '2026-10-05', UNREAD)).toBeNull()
    expect(stagedPeriodLockNote(voucher('2026-10-05'), '2026-10-05', undefined)).toBeNull()
    expect(
      stagedPeriodLockNote(
        { operation_type: 'submit_vat_declaration', params: { period_end: '2026-10-31' }, preview_data: {} },
        '2026-10-31',
        BEHIND_LOCK_DATE,
      ),
    ).toBeNull()
    expect(stagedPeriodLockNote(voucher('2026-11-03'), '2026-10-05', BEHIND_LOCK_DATE)).toBeNull()
  })
})

describe('withPeriodLocks', () => {
  it('reads nothing when no listed row is judged', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    const rows = [{ id: 'op-1', operation_type: 'create_customer', params: {}, preview_data: { name: 'Kund AB' } }]

    await expect(withPeriodLocks(supabase as never, COMPANY, rows)).resolves.toEqual(rows)
    expect(findCall('company_settings', 'select')).toBeUndefined()
  })

  it('hands the queue the lock of each judged row whose posting date is locked now, in two reads', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2026-10-31' } })
    enqueue({
      data: [{ id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }],
    })
    const locked = voucher('2026-10-05')
    const open = { ...voucher('2026-11-03'), id: 'op-open' }
    const bankRow = categorization('2026-10-20')
    const draft = { id: 'op-invoice', operation_type: 'create_invoice', params: { invoice_date: '2026-10-05' }, preview_data: { total: 500 } }

    const listed = await withPeriodLocks(supabase as never, COMPANY, [locked, open, bankRow, draft])

    expect(listed[0].preview_data).toEqual({
      ...locked.preview_data,
      period_status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-10-31', date: '2026-10-05' },
    })
    expect(listed[2].preview_data).toMatchObject({
      period_status: { status: 'locked', lock_date: '2026-10-31', date: '2026-10-20' },
    })
    // Open, and a type a lock does not stop: listed as stored.
    expect(listed[1]).toBe(open)
    expect(listed[3]).toBe(draft)
    // The stored row is not written to.
    expect(locked.preview_data).not.toHaveProperty('period_status')
    expect(findCalls('company_settings', 'select')).toHaveLength(1)
    expect(findCalls('fiscal_periods', 'select')).toHaveLength(1)
  })

  it('lists the rows as stored when the lock cannot be read: no row is called locked on a guess', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout' } })
    const rows = [voucher('2026-10-05')]

    const listed = await withPeriodLocks(supabase as never, COMPANY, rows)

    expect(listed[0]).toBe(rows[0])
  })
})
