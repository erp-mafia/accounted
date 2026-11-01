import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { detectVoucherDuplicates } from '../voucher-duplicate-check'
import { runVoucherWarningsGuard } from '../voucher-warnings-guard'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

/** The agent's re-post of 2026-09-25: the same purchase, 2641 where the first run had 2640. */
const REPOST = {
  entry_date: '2026-08-27',
  description: 'Förbrukningsvaror',
  lines: [
    { account_number: '5460', debit_amount: 1600, credit_amount: 0 },
    { account_number: '2641', debit_amount: 400, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 2000 },
  ],
}
const FIRST_RUN = {
  id: 'je-424',
  voucher_series: 'V',
  voucher_number: 424,
  description: 'Förbrukningsvaror',
  lines: [
    { debit_amount: 1600, credit_amount: 0 },
    { debit_amount: 400, credit_amount: 0 },
    { debit_amount: 0, credit_amount: 2000 },
  ],
}

describe('detectVoucherDuplicates', () => {
  beforeEach(() => reset())

  it('finds a posted voucher with the same date, text and amounts, whatever accounts it used', async () => {
    enqueue({ data: [FIRST_RUN] }) // same-day vouchers
    enqueue({ data: [] }) // cash accounts

    const warnings = await detectVoucherDuplicates(db, 'company-1', REPOST)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ code: 'POSSIBLE_DUPLICATE_VOUCHER', details: { journal_entry_id: 'je-424', voucher: 'V424' } })
  })

  it('never finds the draft being committed as its own twin, nor a voucher with other amounts or text', async () => {
    enqueue({ data: [FIRST_RUN] })
    enqueue({ data: [] })
    expect(await detectVoucherDuplicates(db, 'company-1', REPOST, { excludeJournalEntryId: 'je-424' })).toEqual([])

    enqueue({ data: [{ ...FIRST_RUN, description: 'Kontorsmaterial' }, { ...FIRST_RUN, id: 'je-2', lines: FIRST_RUN.lines.slice(1) }] })
    enqueue({ data: [] })
    expect(await detectVoucherDuplicates(db, 'company-1', REPOST)).toEqual([])
  })

  it('finds a booked bank row of the same account that already books the money', async () => {
    enqueue({ data: [] }) // same-day vouchers
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }] }) // cash accounts
    enqueue({ data: [{ id: 'tx-1', date: '2026-08-28', amount: -2000, description: 'Kortköp' }] }) // rows of that amount
    enqueue({ data: [{ transaction_id: 'tx-1', journal_entry_id: 'je-9' }] }) // live anchors
    enqueue({ data: { id: 'je-9', voucher_series: 'A', voucher_number: 12 } }) // the anchored verifikat

    const warnings = await detectVoucherDuplicates(db, 'company-1', REPOST)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      code: 'BANK_MOVEMENT_ALREADY_BOOKED',
      details: { transaction_id: 'tx-1', journal_entry_id: 'je-9', voucher: 'A12', account: '1930', amount: -2000 },
    })
    // The rows are read booked or not, up to the limit; the anchors decide.
    expect(findCalls('transactions', 'not')).toEqual([])
    expect(findCalls('transactions', 'limit')).toEqual([[20]])
    expect(findCalls('bank_row_anchors', 'select')).toEqual([['transaction_id, journal_entry_id']])
    expect(findCalls('bank_row_anchors', 'in')).toEqual([['transaction_id', ['tx-1']]])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['id', 'je-9'])
  })

  it('leaves a bank row alone when no live verifikat anchors it', async () => {
    enqueue({ data: [] }) // same-day vouchers
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }] }) // cash accounts
    enqueue({ data: [{ id: 'tx-1', date: '2026-08-28', amount: -2000, description: 'Kortköp' }] }) // rows of that amount
    enqueue({ data: [] }) // no anchors

    expect(await detectVoucherDuplicates(db, 'company-1', REPOST)).toEqual([])
  })

  it('leaves a bank line alone when no bank account feeds that ledger account', async () => {
    enqueue({ data: [] })
    enqueue({ data: [] })
    expect(await detectVoucherDuplicates(db, 'company-1', REPOST)).toEqual([])
  })
})

describe('runVoucherWarningsGuard', () => {
  beforeEach(() => reset())

  it('refuses until every warning is acknowledged, then lets the booking through with them', async () => {
    enqueue({ data: [FIRST_RUN] })
    enqueue({ data: [] })
    const refused = await runVoucherWarningsGuard(db, 'company-1', REPOST, log, { acknowledged: [] })
    expect(refused).toMatchObject({ ok: false, code: 'VOUCHER_NEEDS_CONFIRMATION' })

    enqueue({ data: [FIRST_RUN] })
    enqueue({ data: [] })
    const passed = await runVoucherWarningsGuard(db, 'company-1', REPOST, log, { acknowledged: ['POSSIBLE_DUPLICATE_VOUCHER'] })
    expect(passed.ok).toBe(true)
    expect(passed.ok && passed.acknowledged.map((w) => w.code)).toEqual(['POSSIBLE_DUPLICATE_VOUCHER'])
  })

  it('skips the duplicate half when the door judges duplicates itself', async () => {
    const result = await runVoucherWarningsGuard(db, 'company-1', REPOST, log, { checkDuplicates: false })
    expect(result).toEqual({ ok: true, acknowledged: [] })
  })

  it('fails open when the duplicate lookup errors', async () => {
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: [] })
    const result = await runVoucherWarningsGuard(db, 'company-1', REPOST, log)
    expect(result).toEqual({ ok: true, acknowledged: [] })
  })
})
