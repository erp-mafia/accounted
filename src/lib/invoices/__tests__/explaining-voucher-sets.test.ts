/**
 * Tests for detectExplainingVoucherSets, the batch form of the set detector
 * that the reconciliation view runs (#2293).
 *
 * The contract: one ledger scan over the union of the rows' windows, one
 * link-anchor lookup, and per row exactly the single detector's verdict
 * (exact öre sum of unlinked legs in the row's direction on the account,
 * within ±7 days, at most four vouchers); a voucher explains at most one row
 * per call; anything that cannot be judged fails open (no proposal).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectExplainingVoucherSets } from '../duplicate-payment-detection'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

type Leg = {
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entry: {
    id: string
    entry_date: string
    description: string | null
    voucher_series: string
    voucher_number: number
    status: string
    source_type: string | null
    company_id: string
  }
}

function leg(opts: {
  id: string
  date: string
  debit?: number
  credit?: number
  account?: string
  source_type?: string | null
}): Leg {
  return {
    account_number: opts.account ?? '1930',
    debit_amount: opts.debit ?? 0,
    credit_amount: opts.credit ?? 0,
    journal_entry: {
      id: opts.id,
      entry_date: opts.date,
      description: `Voucher ${opts.id}`,
      voucher_series: opts.id[0],
      voucher_number: parseInt(opts.id.slice(1), 10) || 1,
      status: 'posted',
      source_type: opts.source_type === undefined ? 'invoice_paid' : opts.source_type,
      company_id: 'company-1',
    },
  }
}

/** entries page, lines page, then the four link lookups (empty unless given). */
function enqueueScan(
  legs: Leg[],
  links: { transactions?: unknown[]; junction?: unknown[]; invoicePayments?: unknown[] } = {},
) {
  const entries = [...new Map(legs.map((l) => [l.journal_entry.id, l.journal_entry])).values()]
  enqueue({ data: entries })
  if (entries.length === 0) return
  enqueue({
    data: legs.map((l, i) => ({
      id: `line-${i}`,
      journal_entry_id: l.journal_entry.id,
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
    })),
  })
  enqueue({ data: links.invoicePayments ?? [] })
  enqueue({ data: [] })
  enqueue({ data: links.transactions ?? [] })
  enqueue({ data: links.junction ?? [] })
}

const COMPANY = 'company-1'
const row = (id: string, date: string, amount: number) => ({ id, date, amount, currency: 'SEK' })

async function run(transactions: ReturnType<typeof row>[]) {
  return detectExplainingVoucherSets(supabase as never, {
    companyId: COMPANY,
    bankAccountNumber: '1930',
    transactions,
  })
}

describe('detectExplainingVoucherSets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('explains the Bankgirot aggregate with the two mark-paid vouchers in ONE scan', async () => {
    enqueueScan([
      leg({ id: 'A57', date: '2026-07-31', debit: 62500 }),
      leg({ id: 'A58', date: '2026-07-31', debit: 25750 }),
      leg({ id: 'A56', date: '2026-07-20', debit: 150 }),
    ])

    const sets = await run([row('tx-bg', '2026-07-31', 88250), row('tx-other', '2026-07-30', -999)])

    const set = sets.get('tx-bg')
    expect(set).toBeDefined()
    expect(set!.vouchers.map((v) => v.journal_entry_id).sort()).toEqual(['A57', 'A58'])
    expect(set!.vouchers[0]).toMatchObject({ voucher_series: 'A', voucher_number: 57, voucher_label: 'A57' })
    expect(set!.same_date).toBe(true)
    expect(set!.total).toBe(88250)
    expect(sets.has('tx-other')).toBe(false)
    // One entries query, one lines query, four anchor lookups: never per row.
    expect(supabase.from).toHaveBeenCalledTimes(6)
    // The scan covers the union of the rows' ±7-day windows and the account.
    expect(findCalls('journal_entries', 'gte')).toEqual([['entry_date', '2026-07-23']])
    expect(findCalls('journal_entries', 'lte')).toEqual([['entry_date', '2026-08-07']])
    expect(findCalls('journal_entry_lines', 'eq')).toEqual([['account_number', '1930']])
  })

  it('returns nothing when no set of vouchers sums exactly to a row', async () => {
    enqueueScan([leg({ id: 'A1', date: '2026-07-31', debit: 62500 }), leg({ id: 'A2', date: '2026-07-31', debit: 25000 })])

    const sets = await run([row('tx-bg', '2026-07-31', 88250)])

    expect(sets.size).toBe(0)
  })

  it('sums only legs in the row direction and inside the row window', async () => {
    enqueueScan([
      // Right amount, wrong direction (a credit cannot explain money in).
      leg({ id: 'A1', date: '2026-07-31', credit: 62500 }),
      leg({ id: 'A2', date: '2026-07-31', debit: 25750 }),
      // Right amount, eight days off: outside this row's ±7-day window even
      // though the batch scan fetched it for another row.
      leg({ id: 'A3', date: '2026-08-08', debit: 62500 }),
      // Within the window: explains the row together with A2.
      leg({ id: 'A4', date: '2026-08-06', debit: 62500 }),
    ])

    const sets = await run([row('tx-bg', '2026-07-31', 88250), row('tx-late', '2026-08-10', 1)])

    const set = sets.get('tx-bg')
    expect(set!.vouchers.map((v) => v.journal_entry_id).sort()).toEqual(['A2', 'A4'])
    expect(set!.same_date).toBe(false)
  })

  it('stops at four vouchers per set', async () => {
    enqueueScan([
      leg({ id: 'A1', date: '2026-07-31', debit: 100 }),
      leg({ id: 'A2', date: '2026-07-31', debit: 200 }),
      leg({ id: 'A3', date: '2026-07-31', debit: 300 }),
      leg({ id: 'A4', date: '2026-07-31', debit: 400 }),
      leg({ id: 'A5', date: '2026-07-31', debit: 5000 }),
    ])

    // 6000 needs all five legs; 1000 is exactly the four small ones.
    const sets = await run([row('tx-five', '2026-07-31', 6000), row('tx-four', '2026-07-31', 1000)])

    expect(sets.has('tx-five')).toBe(false)
    expect(sets.get('tx-four')!.vouchers.map((v) => v.journal_entry_id).sort()).toEqual(['A1', 'A2', 'A3', 'A4'])
  })

  it('lets a voucher explain at most one row, same-date claims first', async () => {
    enqueueScan([leg({ id: 'A1', date: '2026-07-31', debit: 1000 }), leg({ id: 'A2', date: '2026-07-28', debit: 1000 })])

    // Both rows could take A1; the same-date row gets it, the other re-searches and takes A2.
    const sets = await run([row('tx-early', '2026-07-29', 1000), row('tx-same', '2026-07-31', 1000)])

    expect(sets.get('tx-same')!.vouchers.map((v) => v.journal_entry_id)).toEqual(['A1'])
    expect(sets.get('tx-early')!.vouchers.map((v) => v.journal_entry_id)).toEqual(['A2'])
  })

  it('drops a voucher when nothing is left for the second claim', async () => {
    enqueueScan([leg({ id: 'A1', date: '2026-07-31', debit: 1000 })])

    const sets = await run([row('tx-a', '2026-07-31', 1000), row('tx-b', '2026-07-31', 1000)])

    expect(sets.size).toBe(1)
    expect(sets.get('tx-a')!.vouchers.map((v) => v.journal_entry_id)).toEqual(['A1'])
  })

  it('drops vouchers a bank transaction already explains, but never the rows being explained', async () => {
    enqueueScan(
      [
        leg({ id: 'A57', date: '2026-07-31', debit: 62500 }),
        leg({ id: 'A58', date: '2026-07-31', debit: 25750 }),
        leg({ id: 'A59', date: '2026-07-31', debit: 25750 }),
      ],
      {
        // A58 is settled by another row; A59 is "linked" only from a row in
        // this batch (a stale pointer the batch is explaining), which does not count.
        transactions: [
          { id: 'tx-elsewhere', journal_entry_id: 'A58' },
          { id: 'tx-bg', journal_entry_id: 'A59' },
        ],
      },
    )

    const sets = await run([row('tx-bg', '2026-07-31', 88250)])

    expect(sets.get('tx-bg')!.vouchers.map((v) => v.journal_entry_id).sort()).toEqual(['A57', 'A59'])
  })

  it('never sums storno, correction or opening-balance entries', async () => {
    enqueueScan([
      leg({ id: 'A1', date: '2026-07-31', debit: 500, source_type: 'storno' }),
      leg({ id: 'A2', date: '2026-07-31', debit: 500, source_type: 'correction' }),
      leg({ id: 'A3', date: '2026-07-31', debit: 1000, source_type: 'opening_balance' }),
    ])

    const sets = await run([row('tx', '2026-07-31', 1000)])

    expect(sets.size).toBe(0)
    // Scaffolding never reaches the anchor lookups either.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('skips rows that cannot be stated in SEK or carry no amount, without scanning for them', async () => {
    const sets = await detectExplainingVoucherSets(supabase as never, {
      companyId: COMPANY,
      bankAccountNumber: '1930',
      transactions: [
        { id: 'tx-eur', date: '2026-07-31', amount: 100, currency: 'EUR' },
        { id: 'tx-zero', date: '2026-07-31', amount: 0, currency: 'SEK' },
        { id: 'tx-bad-date', date: 'not-a-date', amount: 100, currency: 'SEK' },
      ],
    })

    expect(sets.size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails open (nothing) when a link lookup resolves with an error', async () => {
    const legs = [leg({ id: 'A1', date: '2026-07-31', debit: 1000 })]
    const entries = legs.map((l) => l.journal_entry)
    enqueue({ data: entries })
    enqueue({
      data: legs.map((l, i) => ({
        id: `line-${i}`,
        journal_entry_id: l.journal_entry.id,
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
      })),
    })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: [] })

    const sets = await run([row('tx', '2026-07-31', 1000)])

    expect(sets.size).toBe(0)
  })

  it('fails open (nothing) when the ledger scan throws', async () => {
    supabase.from.mockImplementationOnce(() => {
      throw new Error('db down')
    })

    const sets = await run([row('tx', '2026-07-31', 1000)])

    expect(sets.size).toBe(0)
  })
})
