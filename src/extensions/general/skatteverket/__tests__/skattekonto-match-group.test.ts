import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findGroupMatchCandidates, matchSkattekontoToEntry } from '../lib/skattekonto-match'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

/**
 * "Matcha mot verifikat" on several ticked skattekonto rows: the candidates
 * are the verifikat whose 1630 movement the whole selection settles, with
 * rows of either sign and on different dates. The motivating case is an
 * imported voucher that netted two same-day events into one 1630 line
 * ("Intäktsränta" 1 000 and "Korrigerad intäktsränta" -400 booked as 600).
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

interface Row {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number
  journal_entry_id: string | null
  is_ignored: boolean
  status: 'booked' | 'upcoming'
}

function row(id: string, date: string, belopp: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    transaktionsdatum: date,
    transaktionstext: `Händelse ${id}`,
    belopp_skatteverket: belopp,
    journal_entry_id: null,
    is_ignored: false,
    status: 'booked',
    ...extra,
  }
}

/** A complete search: the rows, the window's 1630 entries, the links on them, the storno check. */
function enqueueSearch(
  enqueue: Enqueue,
  rows: Row[],
  entries: E[],
  linked: Array<{ journal_entry_id: string; belopp_skatteverket: number }> = [],
) {
  enqueue({ data: rows })
  enqueueCandidateLines(enqueue, entries)
  if (entries.length === 0) return
  enqueue({ data: linked })
  enqueueCancellationRead(enqueue, entries)
}

const INTEREST = row('interest', '2026-04-04', 1000, { transaktionstext: 'Intäktsränta' })
const CORRECTION = row('correction', '2026-04-04', -400, { transaktionstext: 'Korrigerad intäktsränta' })
const NET_INTEREST: E = { id: 'net-interest', voucher: 40, date: '2026-04-04', lines: [['1630', 600, 0], ['8314', 0, 600]], description: 'Intäktsränta' }
const OTHER_INTEREST: E = { id: 'other-interest', voucher: 33, date: '2026-03-25', lines: [['1630', 250, 0], ['8314', 0, 250]] }

describe('findGroupMatchCandidates', () => {
  it.each([
    {
      label: 'interest and its correction (1 000 - 400 = 600)',
      rows: [INTEREST, CORRECTION],
      entry: NET_INTEREST,
      amount: 600,
    },
    {
      label: 'credited preliminary tax and final tax (120 000 - 115 000 = 5 000)',
      rows: [
        row('prel', '2026-12-05', 120000, { transaktionstext: 'Tillgodoförd debiterad preliminärskatt' }),
        row('final', '2026-12-05', -115000, { transaktionstext: 'Slutlig skatt' }),
      ],
      entry: { id: 'net-tax', voucher: 150, date: '2026-12-05', lines: [['1630', 5000, 0], ['2510', 0, 5000]] } as E,
      amount: 5000,
    },
  ])('matches the voucher that netted $label', async ({ rows, entry, amount }) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [entry, OTHER_INTEREST])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, rows.map((r) => r.id))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      journal_entry_id: entry.id,
      matched_amount: amount,
      matched_side: 'debit',
    })
    expect(candidates[0].joins_linked_count).toBeUndefined()
    expect(candidates[0].combined_with).toBeUndefined()
  })

  it('accepts rows on different dates and reads from 14 days before the first to 14 days after the last', async () => {
    const rows = [row('jan5', '2026-01-05', 500), row('jan20', '2026-01-20', 300)]
    const yearEnd: E = { id: 'sum', voucher: 9, date: '2026-01-31', lines: [['1630', 800, 0], ['8314', 0, 800]] }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [yearEnd])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['jan5', 'jan20'])

    expect(candidates.map((c) => c.journal_entry_id)).toEqual(['sum'])
    expect(findCalls('journal_entries', 'gte')[0]).toEqual(['entry_date', '2025-12-22'])
    expect(findCalls('journal_entries', 'lte')[0]).toEqual(['entry_date', '2026-02-03'])
  })

  it('widens the window to the declaration month every row names', async () => {
    const rows = [
      row('tax-may', '2026-06-12', -16223, { transaktionstext: 'Avdragen skatt maj 2026' }),
      row('fee-may', '2026-06-12', -23414, { transaktionstext: 'Arbetsgivaravgift maj 2026' }),
    ]
    const a121: E = { id: 'a121', voucher: 121, date: '2026-05-12', lines: [['1630', 0, 39637], ['2710', 16223, 0], ['2731', 23414, 0]] }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [a121])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['tax-may', 'fee-may'])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ journal_entry_id: 'a121', matched_amount: 39637, matched_side: 'credit' })
    expect(findCalls('journal_entries', 'gte')[0]).toEqual(['entry_date', '2026-05-01'])
  })

  it('offers nothing when no voucher carries the exact sum', async () => {
    const rows = [row('x', '2026-01-05', 500), row('y', '2026-01-05', 300)]
    const close: E = { id: 'close', voucher: 3, date: '2026-01-05', lines: [['1630', 799, 0], ['8314', 0, 799]] }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [close])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['x', 'y'])
    expect(candidates).toEqual([])
  })

  it('offers nothing without reading links or storno pairs when the window holds no 1630 entry', async () => {
    const rows = [INTEREST, CORRECTION]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['interest', 'correction'])
    expect(candidates).toEqual([])
    // The row read only: no link read on skattekonto_transactions follows.
    expect(findCalls('skattekonto_transactions', 'select')).toHaveLength(1)
  })

  it('joins a voucher that already carries a link when the whole group still settles it', async () => {
    const agi: E = { id: 'agi', voucher: 70, date: '2026-03-12', lines: [['1630', 0, 10000], ['2710', 4000, 0], ['2731', 6000, 0]] }
    const rows = [row('part1', '2026-03-12', -2500), row('part2', '2026-03-12', -3500)]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [agi], [{ journal_entry_id: 'agi', belopp_skatteverket: -4000 }])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['part1', 'part2'])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ journal_entry_id: 'agi', joins_linked_count: 1, matched_amount: 6000 })
  })

  it('never lists a voucher cancelled by an imported mirror voucher', async () => {
    const a177: E = { id: 'a177', voucher: 177, date: '2026-07-13', lines: [['1630', 0, 7704], ['2940', 7704, 0]] }
    const a178: E = {
      id: 'a178',
      voucher: 178,
      date: '2026-07-13',
      lines: [['1630', 7704, 0], ['2940', 0, 7704]],
      description: 'Korrigering av ver.nr. A177',
    }
    const rows = [row('p1', '2026-07-13', -4000), row('p2', '2026-07-13', -3704)]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [a177, a178])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['p1', 'p2'])
    expect(candidates).toEqual([])
  })

  it('orders candidates nearest the earliest row first, then by voucher number descending', async () => {
    const rows = [row('x', '2026-01-05', 500), row('y', '2026-01-05', 300)]
    const later: E = { id: 'later', voucher: 20, date: '2026-01-10', lines: [['1630', 800, 0]] }
    const nearLow: E = { id: 'near-low', voucher: 11, date: '2026-01-04', lines: [['1630', 800, 0]] }
    const nearHigh: E = { id: 'near-high', voucher: 12, date: '2026-01-06', lines: [['1630', 800, 0]] }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSearch(enqueue, rows, [later, nearLow, nearHigh])

    const { candidates } = await findGroupMatchCandidates(supabase as never, COMPANY, ['x', 'y'])
    expect(candidates.map((c) => c.journal_entry_id)).toEqual(['near-high', 'near-low', 'later'])
  })

  it('throws a search error, not an empty list, when the storno check cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [INTEREST, CORRECTION] })
    enqueueCandidateLines(enqueue, [NET_INTEREST])
    enqueue({ data: [] }) // links
    enqueue({ data: null, error: { message: 'timeout' } })

    const err = await findGroupMatchCandidates(supabase as never, COMPANY, ['interest', 'correction']).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).not.toBe('SkattekontoMatchError')
    expect(err.message).toMatch(/^Kunde inte söka kandidater/)
  })

  describe('refuses a selection that cannot be linked', () => {
    it('fewer than two distinct rows, before any read', async () => {
      const { supabase, findCalls } = createQueuedMockSupabase()
      await expect(findGroupMatchCandidates(supabase as never, COMPANY, ['a', 'a'])).rejects.toMatchObject({
        name: 'SkattekontoMatchError',
        code: 'INVALID_CANDIDATE',
      })
      expect(findCalls('skattekonto_transactions', 'select')).toHaveLength(0)
    })

    it('more than 50 rows, before any read', async () => {
      const { supabase, findCalls } = createQueuedMockSupabase()
      const ids = Array.from({ length: 51 }, (_, i) => `row-${i}`)
      await expect(findGroupMatchCandidates(supabase as never, COMPANY, ids)).rejects.toMatchObject({
        code: 'INVALID_CANDIDATE',
      })
      expect(findCalls('skattekonto_transactions', 'select')).toHaveLength(0)
    })

    it.each([
      { label: 'a row missing for the company', data: [INTEREST], error: null, code: 'TRANSACTION_NOT_FOUND' },
      { label: 'a failed row read', data: null, error: { message: 'timeout' }, code: 'TRANSACTION_NOT_FOUND' },
      { label: 'a row already linked', data: [INTEREST, { ...CORRECTION, journal_entry_id: 'je-1' }], error: null, code: 'ALREADY_BOOKED' },
      { label: 'an ignored row', data: [INTEREST, { ...CORRECTION, is_ignored: true }], error: null, code: 'ROW_IGNORED' },
      { label: 'a kommande row', data: [INTEREST, { ...CORRECTION, status: 'upcoming' }], error: null, code: 'INVALID_CANDIDATE' },
    ])('$label', async ({ data, error, code }) => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data, error })
      await expect(
        findGroupMatchCandidates(supabase as never, COMPANY, ['interest', 'correction']),
      ).rejects.toMatchObject({ name: 'SkattekontoMatchError', code })
      // Refused before the ledger is read.
      expect(findCalls('journal_entries', 'select')).toHaveLength(0)
    })
  })
})

describe('matchSkattekontoToEntry with a ticked opposite-sign group', () => {
  it('links both rows to the netted voucher in one guarded update', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'interest', belopp_skatteverket: 1000, journal_entry_id: null, is_ignored: false, status: 'booked' },
        { id: 'correction', belopp_skatteverket: -400, journal_entry_id: null, is_ignored: false, status: 'booked' },
      ],
    })
    enqueue({
      data: {
        id: 'net-interest',
        status: 'posted',
        lines: NET_INTEREST.lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
      },
    })
    enqueue({ data: [] }) // no rows already on the voucher
    enqueue({ data: [{ id: 'interest' }, { id: 'correction' }] })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, 'interest', 'net-interest', ['correction']),
    ).resolves.toBeUndefined()
    expect(findCalls('skattekonto_transactions', 'update')).toHaveLength(1)
    expect(findCalls('skattekonto_transactions', 'in')).toContainEqual(['id', ['interest', 'correction']])
  })
})
