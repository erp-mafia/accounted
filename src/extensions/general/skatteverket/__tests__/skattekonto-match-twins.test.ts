import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  clusterProbesByWindow,
  findLedgerTwinCandidates,
  findLedgerTwinCandidatesForIds,
  findMatchSuggestionsBulk,
} from '../lib/skattekonto-match'
import { findSkattekontoLedgerTwins, ledgerTwinMessage } from '../lib/skattekonto-booking'

/**
 * accounted#1300: a company migrates in by SIE (its 1630 events come along as
 * imported verifikat) and then connects the Skatteverket feed. The booking
 * guard asks findLedgerTwinCandidates whether the ledger already holds each
 * row's event; the proposals learn to pair identical rows with identical
 * imported verifikat instead of leaving both unproposed.
 */

const COMPANY = 'company-1'
type Enqueue = (r: { data?: unknown; error?: unknown }) => void

interface E {
  id: string
  voucher: number
  date: string
  /** All lines: [account, debit, credit]. */
  lines: Array<[string, number, number]>
  description?: string
}

function head(e: E) {
  return {
    id: e.id,
    voucher_number: e.voucher,
    voucher_series: 'A',
    entry_date: e.date,
    description: e.description ?? `Verifikat ${e.voucher}`,
    status: 'posted',
    company_id: COMPANY,
    reverses_id: null,
    reversed_by_id: null,
  }
}

/** The candidate read: 1630 lines of the entries in the window (entries page, then lines page). */
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

function skv(id: string, belopp: number, datum = '2026-02-01', text = 'Kostnadsränta') {
  return { id, transaktionsdatum: datum, transaktionstext: text, belopp_skatteverket: belopp, journal_entry_id: null }
}

// Imported interest verifikat (1 kr kostnadsränta: D 8423 / C 1630).
const IMP_A: E = { id: 'imp-a', voucher: 185, date: '2026-02-01', lines: [['1630', 0, 1], ['8423', 1, 0]], description: 'Kostnadsränta (import)' }
const IMP_B: E = { id: 'imp-b', voucher: 186, date: '2026-02-01', lines: [['1630', 0, 1], ['8423', 1, 0]], description: 'Kostnadsränta (import)' }

describe('findLedgerTwinCandidates', () => {
  it('answers every row from one read of the window: a twin for one, nothing for the other', async () => {
    const payment: E = { id: 'pay', voucher: 190, date: '2026-02-10', lines: [['1630', 5794, 0], ['1930', 0, 5794]] }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, payment])
    enqueue({ data: [] }) // none linked
    enqueue({ data: [] }) // open rows on the probes' dates
    enqueueCancellationRead(enqueue, [IMP_A, payment])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [
      skv('interest', -1),
      skv('refund', 250, '2026-02-03', 'Utbetalning'),
      skv('pay-in', 5794, '2026-02-11', 'Inbetalning bokförd'),
    ])

    expect(out.get('interest')?.map((c) => c.journal_entry_id)).toEqual(['imp-a'])
    expect(out.get('interest')?.[0]).toMatchObject({ voucher_number: 185, matched_side: 'credit', matched_amount: 1 })
    expect(out.get('refund')).toEqual([])
    expect(out.get('pay-in')?.map((c) => c.journal_entry_id)).toEqual(['pay'])
    // One entries read for all three rows.
    expect(findCalls('journal_entries', 'gte')).toHaveLength(2) // candidate read + storno read
  })

  it('never counts an entry already linked to another row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A])
    enqueue({ data: [{ journal_entry_id: 'imp-a', belopp_skatteverket: -1 }] }) // linked to an earlier row
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [skv('interest', -1)])
    expect(out.get('interest')).toEqual([])
  })

  it('never counts a verifikat cancelled by an imported storno pair', async () => {
    const correction: E = {
      id: 'imp-a-korr',
      voucher: 187,
      date: '2026-02-01',
      lines: [['1630', 1, 0], ['8423', 0, 1]],
      description: 'Korrigering av ver.nr. A185',
    }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, correction])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, correction])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [skv('interest', -1)])
    expect(out.get('interest')).toEqual([])
  })

  it('reads live verifikat only: a cancelled draft (an abandoned booking keeps its lines) is no twin', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [])

    await findLedgerTwinCandidates(supabase as never, COMPANY, [skv('interest', -1)])
    expect(findCalls('journal_entries', 'in')).toContainEqual(['status', ['draft', 'posted']])
    expect(findCalls('journal_entries', 'neq')).toEqual([])
  })

  it('keeps a batch window per row: rows two months apart each get only their own twin and same-day companions', async () => {
    const jan: E = { id: 'imp-jan', voucher: 201, date: '2026-01-05', lines: [['1630', 0, 1], ['8423', 1, 0]] }
    const mar: E = { id: 'imp-mar', voucher: 202, date: '2026-03-06', lines: [['1630', 0, 1], ['8423', 1, 0]] }
    // Carries the March row together with a second open March row (1 + 2 kr).
    const marBoth: E = { id: 'imp-mar-both', voucher: 203, date: '2026-03-06', lines: [['1630', 0, 3], ['8423', 3, 0]] }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // January's window read ...
    enqueueCandidateLines(enqueue, [jan])
    enqueue({ data: [] }) // none linked
    enqueue({ data: [{ ...skv('p-jan', -1, '2026-01-05'), status: 'booked' }] }) // open rows that day
    enqueueCancellationRead(enqueue, [jan])
    // ... then March's.
    enqueueCandidateLines(enqueue, [mar, marBoth])
    enqueue({ data: [] })
    enqueue({
      data: [
        { ...skv('p-mar', -1, '2026-03-06'), status: 'booked' },
        { ...skv('c-mar', -2, '2026-03-06', 'Förseningsavgift'), status: 'booked' },
      ],
    })
    enqueueCancellationRead(enqueue, [mar, marBoth])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [
      skv('p-mar', -1, '2026-03-06'),
      skv('p-jan', -1, '2026-01-05'),
    ])

    // Each month reads its own window; nothing in between is read.
    const candidateReads = findCalls('journal_entries', 'gte').filter((_, i) => i % 2 === 0)
    expect(candidateReads).toEqual([['entry_date', '2025-12-22'], ['entry_date', '2026-02-20']])
    expect(out.get('p-jan')?.map((c) => c.journal_entry_id)).toEqual(['imp-jan'])
    expect(out.get('p-mar')?.map((c) => c.journal_entry_id).sort()).toEqual(['imp-mar', 'imp-mar-both'])
    const combined = out.get('p-mar')?.find((c) => c.journal_entry_id === 'imp-mar-both')
    expect(combined?.combined_with?.map((c) => c.id)).toEqual(['c-mar'])
  })

  it('never reads the span between rows years apart: work follows the rows, not the batch span', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, []) // 2023 window: no 1630 entries
    enqueueCandidateLines(enqueue, []) // 2026 window: no 1630 entries

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [
      skv('old', -1, '2023-01-10'),
      skv('new', -1, '2026-01-10'),
    ])

    expect(out).toEqual(new Map([['old', []], ['new', []]]))
    expect(findCalls('journal_entries', 'gte')).toEqual([['entry_date', '2022-12-27'], ['entry_date', '2025-12-27']])
    expect(findCalls('journal_entries', 'lte')).toEqual([['entry_date', '2023-01-24'], ['entry_date', '2026-01-24']])
  })

  it('does not let opposite-sign rows of the day crowd a same-sign companion out of the combined pool', async () => {
    // One verifikat carries 1 + 2 kr of interest; the day also has ten
    // refunds (positive rows), which sort before the 2 kr companion by id.
    const both: E = { id: 'imp-both', voucher: 210, date: '2026-02-01', lines: [['1630', 0, 3], ['8423', 3, 0]] }
    const refunds = Array.from({ length: 10 }, (_, i) => ({
      ...skv(`a-refund-${i}`, 100 + i, '2026-02-01', 'Utbetalning'),
      status: 'booked',
    }))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [both])
    enqueue({ data: [] })
    enqueue({ data: [...refunds, { ...skv('z-fee', -2, '2026-02-01', 'Förseningsavgift'), status: 'booked' }] })
    enqueueCancellationRead(enqueue, [both])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [skv('interest', -1)])
    expect(out.get('interest')?.[0]?.combined_with?.map((c) => c.id)).toEqual(['z-fee'])
  })

  it('returns both twins of one row with two imported verifikat on different dates, and the refusal names both', async () => {
    // One 5 kr row; the previous system booked 5 kr on 1630 twice, four days
    // apart. Too ambiguous to propose, so the booking guard must refuse it.
    const first: E = { id: 'imp-5a', voucher: 185, date: '2026-02-01', lines: [['1630', 0, 5], ['8423', 5, 0]] }
    const second: E = { id: 'imp-5b', voucher: 186, date: '2026-02-05', lines: [['1630', 0, 5], ['8423', 5, 0]] }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [first, second])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [first, second])

    const twins = await findSkattekontoLedgerTwins(supabase as never, COMPANY, [skv('five', -5)])

    expect(twins.get('five')?.map((t) => t.journal_entry_id)).toEqual(['imp-5a', 'imp-5b'])
    const message = ledgerTwinMessage(twins.get('five') ?? [])
    expect(message).toContain('verifikat A185 (2026-02-01) och verifikat A186 (2026-02-05)')
    expect(message).toContain('Koppla raden till rätt verifikat')
  })

  it('returns an empty list per row, after one read, when the window has no 1630 entries', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [])

    const out = await findLedgerTwinCandidates(supabase as never, COMPANY, [skv('a', -1), skv('b', -8)])
    expect(out).toEqual(new Map([['a', []], ['b', []]]))
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the link read fails: a linked entry must never pass for a twin', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A])
    enqueue({ data: null, error: { message: 'timeout' } })

    await expect(
      findLedgerTwinCandidates(supabase as never, COMPANY, [skv('interest', -1)]),
    ).rejects.toThrow(/Kunde inte söka kandidater/)
  })
})

describe('clusterProbesByWindow', () => {
  it('groups rows whose windows overlap or lie within a month, and splits rows further apart', () => {
    const clusters = clusterProbesByWindow([
      skv('mar', -1, '2026-03-06'),
      skv('jan', -1, '2026-01-05'),
      skv('feb', -1, '2026-02-15'), // window from 2026-02-01: within a month of January's (to 2026-01-19)
      skv('old', -1, '2023-06-01'),
    ])
    expect(clusters.map((c) => c.map((p) => p.id))).toEqual([['old'], ['jan', 'feb', 'mar']])
  })

  it('reaches a combined window back to its AGI period start', () => {
    // "Avdragen skatt maj 2026" drawn 2026-06-12 accepts a verifikat from 2026-05-01.
    const clusters = clusterProbesByWindow([
      skv('april', -1, '2026-03-20'),
      skv('agi', -1, '2026-06-12', 'Avdragen skatt maj 2026'),
    ])
    expect(clusters).toHaveLength(1)
  })
})

describe('findLedgerTwinCandidatesForIds', () => {
  it('reads the open rows, then searches them', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [skv('interest', -1)] }) // open rows for the ids
    enqueueCandidateLines(enqueue, [IMP_A])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A])

    const out = await findLedgerTwinCandidatesForIds(supabase as never, COMPANY, ['interest', 'booked-row'])
    expect(out.get('interest')?.map((c) => c.journal_entry_id)).toEqual(['imp-a'])
    // A booked (or ignored, or unknown) id is not open: left for the booking gates.
    expect(out.has('booked-row')).toBe(false)
    expect(findCalls('skattekonto_transactions', 'is')[0]).toEqual(['journal_entry_id', null])
  })

  it('makes no query for an empty id list', async () => {
    const { supabase } = createQueuedMockSupabase()
    const out = await findLedgerTwinCandidatesForIds(supabase as never, COMPANY, [])
    expect(out.size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('findMatchSuggestionsBulk: interchangeable identical rows', () => {
  it('pairs two identical rows with two identical imported verifikat one to one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, IMP_B])
    enqueue({ data: [] }) // none linked
    enqueueCancellationRead(enqueue, [IMP_A, IMP_B])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('r1', -1), skv('r2', -1)])

    expect(out.get('r1')?.journal_entry_id).toBe('imp-a')
    expect(out.get('r2')?.journal_entry_id).toBe('imp-b')
  })

  it('also pairs them when the verifikat sit on different dates inside the window', async () => {
    const later: E = { ...IMP_B, date: '2026-02-04' }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, later])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, later])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('r1', -1), skv('r2', -1)])
    expect(new Set([out.get('r1')?.journal_entry_id, out.get('r2')?.journal_entry_id])).toEqual(
      new Set(['imp-a', 'imp-b']),
    )
  })

  it('proposes live verifikat only, the same set the booking guard reads', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [])

    await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('r1', -1)])
    expect(findCalls('journal_entries', 'in')).toContainEqual(['status', ['draft', 'posted']])
  })

  it('leaves one row against two verifikat on different dates unproposed (genuinely ambiguous)', async () => {
    const later: E = { ...IMP_B, date: '2026-02-05' }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, later])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, later])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('r1', -1)])
    expect(out.size).toBe(0)
  })

  it('leaves an existing combined proposal alone: the pairing only fills rows nothing else proposed', async () => {
    const both: E = { id: 'imp-both', voucher: 188, date: '2026-02-01', lines: [['1630', 0, 2], ['8423', 2, 0]] }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, IMP_B, both])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, IMP_B, both])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [skv('r1', -1), skv('r2', -1)])
    expect(out.get('r1')?.journal_entry_id).toBe('imp-both')
    expect(out.get('r2')?.journal_entry_id).toBe('imp-both')
    expect(out.get('r1')?.combined_with?.map((c) => c.id)).toEqual(['r2'])
  })

  it('does not pair rows whose texts differ: they are not interchangeable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, IMP_B])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, IMP_B])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      skv('r1', -1, '2026-02-01', 'Kostnadsränta'),
      skv('r2', -1, '2026-02-01', 'Förseningsavgift'),
    ])
    expect(out.size).toBe(0)
  })

  it('does not pair them when another open row also wants one of the verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [IMP_A, IMP_B])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [IMP_A, IMP_B])

    const out = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      skv('r1', -1),
      skv('r2', -1),
      // A third 1 kr row three days later sees the same two verifikat.
      skv('r3', -1, '2026-02-04'),
    ])
    expect(out.size).toBe(0)
  })
})
