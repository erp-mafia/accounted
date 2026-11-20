import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  findGroupMatchCandidates,
  findLedgerTwinCandidates,
  findMatchSuggestionsBulk,
} from '../lib/skattekonto-match'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts).
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

/**
 * Issue #50: one Skatteverket event linked over two verifikat (crm#1183,
 * lib/reconciliation/skattekonto-split.ts). The event row (+29) points at
 * the primary (+37 on 1630, a remainder of +8 the row does not explain), and
 * the remainder is settled against a correcting verifikat (-8) in
 * account_reconciliation_settlements. Read without the settlement, both look
 * open: a later -8 row was proposed the correction and a +8 row the
 * primary, and linking either broke the settlement. Settled verifikat are
 * never candidates.
 */

const COMPANY = 'company-1'
type Enqueue = (r: { data?: unknown; error?: unknown }) => void

interface E {
  id: string
  voucher: number
  date: string
  /** All lines: [account, debit, credit]. */
  lines: Array<[string, number, number]>
}

function head(e: E) {
  return {
    id: e.id,
    voucher_number: e.voucher,
    voucher_series: 'A',
    entry_date: e.date,
    description: `Verifikat ${e.voucher}`,
    status: 'posted',
    company_id: COMPANY,
    reverses_id: null,
    reversed_by_id: null,
  }
}

/** Entries page, then their 1630 lines. */
function enqueueCandidateLines(enqueue: Enqueue, entries: E[]) {
  enqueue({ data: entries.map(head) })
  if (entries.length === 0) return
  enqueue({
    data: entries.flatMap((e, i) =>
      e.lines
        .filter(([acc]) => acc === '1630')
        .map(([, d, c], j) => ({ id: `l-${i}-${j}`, journal_entry_id: e.id, debit_amount: d, credit_amount: c })),
    ),
  })
}

/** The storno check: 1630 entries around the window, their 1630 lines, then ALL their lines. */
function enqueueCancellationRead(enqueue: Enqueue, entries: E[]) {
  enqueueCandidateLines(enqueue, entries)
  if (entries.length === 0) return
  enqueue({
    data: entries.flatMap((e, i) =>
      e.lines.map(([account_number, d, c], j) => ({
        id: `a-${i}-${j}`,
        journal_entry_id: e.id,
        account_number,
        debit_amount: d,
        credit_amount: c,
      })),
    ),
  })
}

function settlementRows(settlementId: string, members: Array<[string, number]>) {
  return members.map(([journal_entry_id, amount]) => ({
    settlement_id: settlementId,
    journal_entry_id,
    amount,
    settled_by: 'user-1',
    settled_at: '2026-10-14T13:36:51Z',
  }))
}

function skv(id: string, belopp: number, datum = '2025-04-23', text = 'Korrigering') {
  return { id, transaktionsdatum: datum, transaktionstext: text, belopp_skatteverket: belopp, journal_entry_id: null }
}

// The primary: +37 on 1630 (an imported booking at the wrong amount), the
// event row of +29 points here. The correction: -8 on 1630.
const PRIMARY: E = { id: 'primary', voucher: 77, date: '2025-04-23', lines: [['1630', 37, 0], ['8314', 0, 37]] }
const CORRECTION: E = { id: 'correction', voucher: 76, date: '2025-04-23', lines: [['1630', 0, 8], ['8314', 8, 0]] }
const LINKED_EVENT = { journal_entry_id: 'primary', belopp_skatteverket: 29 }
const SETTLEMENT = settlementRows('s-1', [
  ['primary', 8],
  ['correction', -8],
])

describe('findMatchSuggestionsBulk: verifikat held by a live settlement (issue #50)', () => {
  it('without the settlement the -8 and +8 rows are proposed the two verifikat (the shape the settlement must stop)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [PRIMARY, CORRECTION])
    enqueue({ data: [LINKED_EVENT] }) // rows already linked
    enqueueCancellationRead(enqueue, [PRIMARY, CORRECTION])
    enqueue({ data: [] }) // no live settlement

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('minus', -8), skv('plus', 8)])

    expect(out.get('minus')?.journal_entry_id).toBe('correction')
    expect(out.get('plus')?.journal_entry_id).toBe('primary')
  })

  it('proposes neither verifikat of a live settlement', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [PRIMARY, CORRECTION])
    enqueue({ data: [LINKED_EVENT] })
    enqueueCancellationRead(enqueue, [PRIMARY, CORRECTION])
    enqueue({ data: SETTLEMENT })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('minus', -8), skv('plus', 8)])

    expect(out.size).toBe(0)
    // Live settlements on the company's skattekonto account only.
    expect(findCalls('account_reconciliation_settlements', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['account_number', '1630'],
    ])
    expect(findCalls('account_reconciliation_settlements', 'is')).toEqual([['undone_at', null]])
  })

  it('reads the settlements of the account the caller resolved (2012 for an enskild firma)', async () => {
    const onEquity: E = { id: 'ef-1', voucher: 5, date: '2025-04-23', lines: [['2012', 0, 8], ['8314', 8, 0]] }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [head(onEquity)] })
    enqueue({ data: [{ id: 'l-0', journal_entry_id: 'ef-1', debit_amount: 0, credit_amount: 8 }] })
    enqueue({ data: [] })
    enqueue({ data: [head(onEquity)] })
    enqueue({ data: [{ id: 'l-0', journal_entry_id: 'ef-1', debit_amount: 0, credit_amount: 8 }] })
    enqueue({
      data: onEquity.lines.map(([account_number, d, c], j) => ({
        id: `a-${j}`,
        journal_entry_id: 'ef-1',
        account_number,
        debit_amount: d,
        credit_amount: c,
      })),
    })
    enqueue({ data: settlementRows('s-2', [['ef-1', -8], ['other', 8]]) })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('minus', -8)], '2012')

    expect(out.size).toBe(0)
    expect(findCalls('account_reconciliation_settlements', 'eq')).toContainEqual(['account_number', '2012'])
  })

  it('proposes nothing when the settlement read fails (no candidate is safe)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [CORRECTION])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [CORRECTION])
    enqueue({ error: { message: 'boom' } })

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('minus', -8)])
    expect(out.size).toBe(0)
  })
})

describe('findLedgerTwinCandidates: a settled verifikat is no twin (issue #50)', () => {
  it('lists the correction for a -8 row only while no settlement holds it', async () => {
    const run = async (settlement: unknown[]) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueueCandidateLines(enqueue, [PRIMARY, CORRECTION])
      enqueue({ data: [LINKED_EVENT] }) // rows already linked
      enqueue({ data: [] }) // open rows on the probe's dates
      enqueueCancellationRead(enqueue, [PRIMARY, CORRECTION])
      enqueue({ data: settlement })
      return findLedgerTwinCandidates(supabase as never, COMPANY, [skv('minus', -8)])
    }

    expect((await run([])).get('minus')?.map((c) => c.journal_entry_id)).toEqual(['correction'])
    expect((await run(SETTLEMENT)).get('minus')).toEqual([])
  })

  it('throws a search failure when the settlement read fails, never an empty answer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [CORRECTION])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [CORRECTION])
    enqueue({ error: { message: 'boom' } })

    await expect(findLedgerTwinCandidates(supabase as never, COMPANY, [skv('minus', -8)])).rejects.toThrow(
      /Kunde inte söka kandidater/,
    )
  })
})

describe('findGroupMatchCandidates: a ticked selection is not offered a settled verifikat (issue #50)', () => {
  it('leaves out the primary that two rows (+5, +3) would otherwise settle with its linked row', async () => {
    const rows = [
      { ...skv('a', 5), is_ignored: false, status: 'booked' },
      { ...skv('b', 3), is_ignored: false, status: 'booked' },
    ]
    const run = async (settlement: unknown[]) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: rows })
      enqueueCandidateLines(enqueue, [PRIMARY])
      enqueue({ data: [LINKED_EVENT] })
      enqueueCancellationRead(enqueue, [PRIMARY])
      enqueue({ data: settlement })
      return findGroupMatchCandidates(supabase as never, COMPANY, ['a', 'b'], '1630')
    }

    expect((await run([])).candidates.map((c) => c.journal_entry_id)).toEqual(['primary'])
    expect((await run(SETTLEMENT)).candidates).toEqual([])
  })
})
