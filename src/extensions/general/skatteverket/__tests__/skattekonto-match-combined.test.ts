import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  combinedMatchWindow,
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
} from '../lib/skattekonto-match'

/**
 * crm#128: an imported AGI voucher books avdragen skatt + arbetsgivaravgift
 * as ONE 1630 credit, while Skatteverket posts two events. Also: a voucher
 * reversed by an imported mirror voucher must never be a match target.
 * crm#104: a payment and a debit booked in one voucher.
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

const A157: E = { id: 'a157', voucher: 157, date: '2026-07-13', lines: [['1630', 0, 12225], ['2710', 4521, 0], ['2731', 7704, 0]] }
const A177: E = { id: 'a177', voucher: 177, date: '2026-07-13', lines: [['1630', 0, 7704], ['2940', 7704, 0]] }
const A178: E = {
  id: 'a178',
  voucher: 178,
  date: '2026-07-13',
  lines: [['1630', 7704, 0], ['2940', 0, 7704]],
  description: 'Korrigering av ver.nr. A177',
}

const TAX_JUNE = { id: 'skv-tax', transaktionsdatum: '2026-07-13', transaktionstext: 'Avdragen skatt juni 2026', belopp_skatteverket: -4521, journal_entry_id: null }
const FEE_JUNE = { id: 'skv-fee', transaktionsdatum: '2026-07-13', transaktionstext: 'Arbetsgivaravgift juni 2026', belopp_skatteverket: -7704, journal_entry_id: null }

describe('combinedMatchWindow', () => {
  it('is +/-14 days, widened back to the start of a shared AGI period', () => {
    expect(combinedMatchWindow('2026-06-12', [{ transaktionstext: 'Avdragen skatt maj 2026' }, { transaktionstext: 'Arbetsgivaravgift maj 2026' }])).toEqual({ from: '2026-05-01', to: '2026-06-26' })
    expect(combinedMatchWindow('2026-06-12', [{ transaktionstext: 'Avdragen skatt maj 2026' }, { transaktionstext: 'Arbetsgivaravgift april 2026' }])).toEqual({ from: '2026-05-29', to: '2026-06-26' })
    expect(combinedMatchWindow('2026-06-12', [{ transaktionstext: 'Debiterad preliminärskatt' }])).toEqual({ from: '2026-05-29', to: '2026-06-26' })
  })
})

describe('findMatchSuggestionsBulk: combined + storno', () => {
  it('proposes the combined AGI voucher for both events and never the reversed one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [A157, A177, A178])
    enqueue({ data: [] }) // none linked
    enqueue({ data: [] }) // agi_declarations
    enqueueCancellationRead(enqueue, [A157, A177, A178])

    const result = await findMatchSuggestionsBulk(supabase as never, COMPANY, [TAX_JUNE, FEE_JUNE])

    expect(result.get('skv-tax')?.journal_entry_id).toBe('a157')
    expect(result.get('skv-fee')?.journal_entry_id).toBe('a157')
    expect(result.get('skv-tax')?.combined_with?.map((o) => o.id)).toEqual(['skv-fee'])
    expect(result.get('skv-fee')?.combined_with?.map((o) => o.id)).toEqual(['skv-tax'])
    expect(result.get('skv-fee')?.combined_total).toBe(12225)
  })

  it('bridges the 31-day gap through the declaration month', async () => {
    const a121: E = { id: 'a121', voucher: 121, date: '2026-05-12', lines: [['1630', 0, 39637], ['2710', 16223, 0], ['2731', 23414, 0]] }
    const rows = [
      { id: 'tax-may', transaktionsdatum: '2026-06-12', transaktionstext: 'Avdragen skatt maj 2026', belopp_skatteverket: -16223, journal_entry_id: null },
      { id: 'fee-may', transaktionsdatum: '2026-06-12', transaktionstext: 'Arbetsgivaravgift maj 2026', belopp_skatteverket: -23414, journal_entry_id: null },
    ]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [a121])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [a121])

    const result = await findMatchSuggestionsBulk(supabase as never, COMPANY, rows)

    expect(result.get('tax-may')?.journal_entry_id).toBe('a121')
    expect(result.get('fee-may')?.journal_entry_id).toBe('a121')
    expect(findCalls('journal_entries', 'gte')[0]).toEqual(['entry_date', '2026-05-01'])
  })

  it('does not bridge a long gap when the events name no AGI period', async () => {
    const a121: E = { id: 'a121', voucher: 121, date: '2026-05-12', lines: [['1630', 0, 3000]] }
    const rows = [
      { id: 'x1', transaktionsdatum: '2026-06-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -1000, journal_entry_id: null },
      { id: 'x2', transaktionsdatum: '2026-06-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -2000, journal_entry_id: null },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [a121])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [a121])

    const result = await findMatchSuggestionsBulk(supabase as never, COMPANY, rows)
    expect(result.size).toBe(0)
  })

  it('proposes nothing when two vouchers carry the combined amount', async () => {
    const twin: E = { ...A157, id: 'a158', voucher: 158, date: '2026-07-14' }
    const rows = [
      { ...TAX_JUNE, transaktionstext: 'Skatt' },
      { ...FEE_JUNE, transaktionstext: 'Avgift' },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [A157, twin])
    enqueue({ data: [] })
    enqueueCancellationRead(enqueue, [A157, twin])

    const result = await findMatchSuggestionsBulk(supabase as never, COMPANY, rows)
    expect(result.size).toBe(0)
  })

  it('proposes nothing when the storno check cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueCandidateLines(enqueue, [A177])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null, error: { message: 'timeout' } })

    const result = await findMatchSuggestionsBulk(supabase as never, COMPANY, [FEE_JUNE])
    expect(result.size).toBe(0)
  })
})

describe('findMatchCandidates: combined, joined, storno', () => {
  it('lists the combined voucher with the companion event and hides the storno pair', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...TAX_JUNE, company_id: COMPANY, status: 'booked' } })
    enqueueCandidateLines(enqueue, [A157, A177, A178])
    enqueue({ data: [] }) // none linked
    enqueue({ data: [] }) // agi_declarations
    enqueue({ data: [FEE_JUNE] }) // companions
    enqueueCancellationRead(enqueue, [A157, A177, A178])

    const { candidates } = await findMatchCandidates(supabase as never, COMPANY, 'skv-tax')

    expect(candidates.map((c) => c.journal_entry_id)).toEqual(['a157'])
    expect(candidates[0].combined_with?.map((o) => o.id)).toEqual(['skv-fee'])
    expect(candidates[0].combined_total).toBe(12225)
  })

  it('lists a voucher already linked to the payment for the debit it also books (crm#104)', async () => {
    const both: E = { id: 'pay', voucher: 50, date: '2026-03-12', lines: [['1630', 10000, 0], ['1630', 0, 10000], ['1930', 0, 10000], ['2518', 10000, 0]] }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'debit', company_id: COMPANY, transaktionsdatum: '2026-03-12', transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -10000, journal_entry_id: null, status: 'booked' } })
    enqueueCandidateLines(enqueue, [both])
    enqueue({ data: [{ journal_entry_id: 'pay', belopp_skatteverket: 10000 }] })
    enqueue({ data: [] }) // companions
    enqueueCancellationRead(enqueue, [both])

    const { candidates } = await findMatchCandidates(supabase as never, COMPANY, 'debit')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ journal_entry_id: 'pay', joins_linked_count: 1 })
  })
})

describe('matchSkattekontoToEntry with a combined candidate', () => {
  it('links the whole group in one guarded update', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'skv-tax', belopp_skatteverket: -4521, journal_entry_id: null, is_ignored: false, status: 'booked' },
        { id: 'skv-fee', belopp_skatteverket: -7704, journal_entry_id: null, is_ignored: false, status: 'booked' },
      ],
    })
    enqueue({ data: { id: 'a157', status: 'posted', lines: A157.lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })) } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'skv-tax' }, { id: 'skv-fee' }] })

    await expect(matchSkattekontoToEntry(supabase as never, COMPANY, 'skv-tax', 'a157', ['skv-fee'])).resolves.toBeUndefined()
    expect(findCalls('skattekonto_transactions', 'update')).toHaveLength(1)
    expect(findCalls('skattekonto_transactions', 'in')).toContainEqual(['id', ['skv-tax', 'skv-fee']])
  })

  it('maps a refused group to the match error codes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'skv-tax', belopp_skatteverket: -4521, journal_entry_id: null, is_ignored: false, status: 'booked' },
        { id: 'skv-fee', belopp_skatteverket: -7704, journal_entry_id: null, is_ignored: false, status: 'booked' },
      ],
    })
    enqueue({ data: { id: 'a177', status: 'posted', lines: [{ account_number: '1630', debit_amount: 0, credit_amount: 7704 }] } })
    await expect(matchSkattekontoToEntry(supabase as never, COMPANY, 'skv-tax', 'a177', ['skv-fee'])).rejects.toMatchObject({
      name: 'SkattekontoMatchError',
      code: 'INVALID_CANDIDATE',
    })
  })
})
