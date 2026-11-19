import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { findSalaryRunPayouts, salaryPayoutLinkProposal, SALARY_RUN_MISSING_HINT } from '../salary-run-payouts'

/**
 * A net-pay bank row a booked salary run already books is offered the link
 * to the run's verifikat (crm#1462); a row with no run near it is flagged so
 * a net-salary proposal can say to create the run first.
 */

const COMPANY = 'company-1'

const payout = (over: Parameters<typeof makeTransaction>[0] = {}) =>
  makeTransaction({
    id: 'tx-pay',
    amount: -59696,
    currency: 'SEK',
    date: '2026-10-24',
    journal_entry_id: null,
    is_ignored: false,
    cash_account_id: 'ca-1930',
    ...over,
  })

const run = { id: 'run-10', period_year: 2026, period_month: 10, payment_date: '2026-10-25', salary_entry_id: 'je-run' }
const entry = { id: 'je-run', voucher_series: 'L', voucher_number: 12, entry_date: '2026-10-25' }
const netLeg = { journal_entry_id: 'je-run', account_number: '1930', credit_amount: 59696 }

function bookedRunReads(
  mock: ReturnType<typeof createQueuedMockSupabase>,
  over: { lines?: unknown[]; linked?: unknown[]; voucherLinks?: unknown[]; cash?: unknown[] } = {},
) {
  mock.enqueueMany([
    { data: [run] }, // salary_runs
    { data: [entry] }, // journal_entries
    { data: over.lines ?? [netLeg] }, // journal_entry_lines
    { data: over.linked ?? [] }, // transactions already on the verifikat
    { data: over.voucherLinks ?? [] }, // transaction_voucher_links
    { data: over.cash ?? [{ id: 'ca-1930', ledger_account: '1930' }] }, // cash_accounts
  ])
}

describe('findSalaryRunPayouts', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
  })

  it('links the open net-pay row to the booked run verifikat', async () => {
    bookedRunReads(mock)
    const { links, without_run } = await findSalaryRunPayouts(supabase, COMPANY, [payout()])
    expect(links.get('tx-pay')).toEqual({
      journal_entry_id: 'je-run',
      salary_run_id: 'run-10',
      voucher: 'L12',
      entry_date: '2026-10-25',
      period: '2026-10',
    })
    expect(without_run.size).toBe(0)
  })

  it('reads nothing for rows that cannot be a payout (money in, booked, ignored, foreign currency)', async () => {
    const { links } = await findSalaryRunPayouts(supabase, COMPANY, [
      payout({ id: 'in', amount: 59696 }),
      payout({ id: 'booked', journal_entry_id: 'je-x' }),
      payout({ id: 'ignored', is_ignored: true }),
      payout({ id: 'eur', currency: 'EUR' }),
    ])
    expect(links.size).toBe(0)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('does not offer a verifikat another bank row already books', async () => {
    bookedRunReads(mock, { linked: [{ journal_entry_id: 'je-run' }] })
    expect((await findSalaryRunPayouts(supabase, COMPANY, [payout()])).links.size).toBe(0)
  })

  it('does not offer a verifikat bulk-linked to a bank row', async () => {
    bookedRunReads(mock, { voucherLinks: [{ journal_entry_id: 'je-run' }] })
    expect((await findSalaryRunPayouts(supabase, COMPANY, [payout()])).links.size).toBe(0)
  })

  it('needs the same öre on the same bank account inside the window', async () => {
    bookedRunReads(mock)
    expect((await findSalaryRunPayouts(supabase, COMPANY, [payout({ amount: -59695.99 })])).links.size).toBe(0)

    bookedRunReads(mock, { cash: [{ id: 'ca-1930', ledger_account: '1931' }] })
    expect((await findSalaryRunPayouts(supabase, COMPANY, [payout()])).links.size).toBe(0)

    bookedRunReads(mock)
    expect((await findSalaryRunPayouts(supabase, COMPANY, [payout({ date: '2026-10-10' })])).links.size).toBe(0)
  })

  it('gives one payout to one row: the closest date', async () => {
    bookedRunReads(mock)
    const { links } = await findSalaryRunPayouts(supabase, COMPANY, [
      payout({ id: 'far', date: '2026-10-20' }),
      payout({ id: 'near', date: '2026-10-25' }),
    ])
    expect([...links.keys()]).toEqual(['near'])
  })

  it('flags a net-salary row with no run paid nearby when the company has employees', async () => {
    mock.enqueueMany([{ data: [] }, { count: 2 }])
    const { links, without_run } = await findSalaryRunPayouts(supabase, COMPANY, [payout()], new Set(['tx-pay']))
    expect(links.size).toBe(0)
    expect([...without_run]).toEqual(['tx-pay'])
  })

  it('does not flag it in a company with no employees (salary run elsewhere)', async () => {
    mock.enqueueMany([{ data: [] }, { count: 0 }])
    const { without_run } = await findSalaryRunPayouts(supabase, COMPANY, [payout()], new Set(['tx-pay']))
    expect(without_run.size).toBe(0)
  })

  it('does not flag a row when an unbooked run is paid nearby', async () => {
    mock.enqueueMany([{ data: [{ ...run, salary_entry_id: null }] }])
    const { links, without_run } = await findSalaryRunPayouts(supabase, COMPANY, [payout()], new Set(['tx-pay']))
    expect(links.size).toBe(0)
    expect(without_run.size).toBe(0)
  })

  it('throws on a read error (the caller treats it as no suggestion)', async () => {
    mock.enqueueMany([{ error: { message: 'boom' } }])
    await expect(findSalaryRunPayouts(supabase, COMPANY, [payout()])).rejects.toBeTruthy()
  })
})

describe('salaryPayoutLinkProposal', () => {
  const link = { journal_entry_id: 'je-run', salary_run_id: 'run-10', voucher: 'L12', entry_date: '2026-10-25', period: '2026-10' }

  it('links with gnubok_reconcile_match arguments and never books from the row', () => {
    expect(salaryPayoutLinkProposal({ id: 'tx-pay', cash_account_id: 'ca-1930' }, link)).toMatchObject({
      source: 'ledger_link',
      books_without_review: false,
      link_args: { account_key: 'bank:ca-1930', pairs: [{ external_ids: ['tx-pay'], journal_entry_ids: ['je-run'] }] },
    })
  })

  it('offers nothing for a row with no cash account', () => {
    expect(salaryPayoutLinkProposal({ id: 'tx-pay', cash_account_id: null }, link)).toBeNull()
  })

  it('the missing-run hint names the tool that creates the run', () => {
    expect(SALARY_RUN_MISSING_HINT).toContain('gnubok_create_salary_run')
  })
})
