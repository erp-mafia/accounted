import { describe, it, expect } from 'vitest'
import {
  MAX_PLAN_ROWS_PER_ENTRY,
  planSkattekontoLedgerLinks,
  type LedgerPlanEntry,
  type LedgerPlanRow,
} from '../skattekonto-ledger-plan'

const r = (id: string, date: string, amount: number, linkable = true): LedgerPlanRow => ({ id, date, amount, linkable })
const v = (id: string, date: string, amount: number, linkable = true): LedgerPlanEntry => ({ id, date, amount, linkable })

/**
 * One month the way the previous system booked it (PH 171): the interest
 * row a week before the draw, three charges on the draw day, and one
 * verifikat on the draw day holding all four.
 */
function month(prefix: string, interestDate: string, drawDate: string, charges: number[], interest: number) {
  const rows = [r(`${prefix}-i`, interestDate, interest), ...charges.map((c, i) => r(`${prefix}-${i}`, drawDate, c))]
  const total = Math.round((charges.reduce((s, c) => s + c, 0) + interest) * 100) / 100
  return { rows, entry: v(`M-${prefix}`, drawDate, total) }
}

describe('planSkattekontoLedgerLinks', () => {
  it('links a month of rows to the one verifikat that holds them, interest a week early included', () => {
    const july = month('jul', '2025-07-05', '2025-07-14', [-33682, -25746, -9884], 91)
    expect(planSkattekontoLedgerLinks({ rows: july.rows, entries: [july.entry] })).toEqual([
      {
        journal_entry_id: 'M-jul',
        event_ids: ['jul-i', 'jul-0', 'jul-1', 'jul-2'],
        total: -69221,
        from_date: '2025-07-05',
        to_date: '2025-07-14',
      },
    ])
  })

  it('splits a year of monthly summaries into one link per verifikat', () => {
    const months = [
      month('jul', '2025-07-05', '2025-07-14', [-33682, -25746, -9884], 91),
      month('aug', '2025-08-02', '2025-08-18', [-114824, -16841, -12873, -11393], 74),
      month('sep', '2025-09-06', '2025-09-12', [-11393, -227, -129], 94),
    ]
    const planned = planSkattekontoLedgerLinks({
      rows: months.flatMap((m) => m.rows),
      entries: months.map((m) => m.entry),
    })
    expect(planned.map((p) => [p.journal_entry_id, p.event_ids.length])).toEqual([
      ['M-jul', 4],
      ['M-aug', 5],
      ['M-sep', 4],
    ])
  })

  it('leaves a month alone whose rows do not add up (a row ignored or really missing), and still links the months after it', () => {
    const april = month('apr', '2026-04-04', '2026-04-13', [-34582, -27506, -11393], 62)
    const may = month('may', '2026-05-02', '2026-05-12', [-111582, -17291, -13753, -11393], 54)
    // The April preliminärskatt row is ignored: the verifikat holds 11 393 more than the open rows.
    const aprilRows = april.rows.filter((row) => row.id !== 'apr-2')
    const planned = planSkattekontoLedgerLinks({ rows: [...aprilRows, ...may.rows], entries: [april.entry, may.entry] })
    expect(planned.map((p) => p.journal_entry_id)).toEqual(['M-may'])
    expect(planned[0].event_ids).toEqual(['may-i', 'may-0', 'may-1', 'may-2', 'may-3'])
  })

  it('pairs a verifikat with rows posted weeks later around the months linked in between', () => {
    // Moms for Q2 booked on the period end, posted by Skatteverket on 12 August.
    const moms = v('M-moms', '2025-06-30', -114824)
    const july = month('jul', '2025-07-05', '2025-07-14', [-33682, -25746], 91)
    const momsRow = r('moms', '2025-08-12', -114824)
    const planned = planSkattekontoLedgerLinks({ rows: [...july.rows, momsRow], entries: [moms, july.entry] })
    expect(planned).toEqual([
      expect.objectContaining({ journal_entry_id: 'M-jul', event_ids: ['jul-i', 'jul-0', 'jul-1'] }),
      expect.objectContaining({ journal_entry_id: 'M-moms', event_ids: ['moms'], from_date: '2025-06-30', to_date: '2025-08-12' }),
    ])
  })

  it('never guesses which of two verifikat holds which rows', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2026-02-12', -101465), r('b', '2026-02-12', -34582), r('c', '2026-02-12', -27506)],
      entries: [v('M1', '2026-02-12', -101465), v('M2', '2026-02-12', -62088)],
    })
    expect(planned).toEqual([])
  })

  it('takes the one verifikat equal to the rows beside an annulment pair that cancels itself', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2025-10-13', -11393), r('b', '2025-10-13', -227), r('c', '2025-10-13', -129)],
      entries: [v('M99', '2025-10-13', 11712), v('M58', '2025-10-13', -11712), v('M100', '2025-10-13', -11749)],
    })
    expect(planned).toEqual([expect.objectContaining({ journal_entry_id: 'M100', event_ids: ['a', 'b', 'c'] })])
  })

  it('splits two months at the change of date when a summary is dated after the next month\'s interest row', () => {
    // September's summary is dated 9 October, after the interest rows of 4
    // October that belong to October's summary; an annulment pair sits beside
    // October's.
    const planned = planSkattekontoLedgerLinks({
      rows: [
        r('sep-ranta', '2025-09-06', 94),
        r('sep-prel', '2025-09-12', -11393),
        r('sep-skatt', '2025-09-12', -227),
        r('sep-ag', '2025-09-12', -129),
        r('okt-korr', '2025-10-04', -78),
        r('okt-ranta', '2025-10-04', 62),
        r('okt-prel', '2025-10-13', -11393),
        r('okt-skatt', '2025-10-13', -227),
        r('okt-ag', '2025-10-13', -129),
      ],
      entries: [
        v('M30', '2025-10-09', -11655),
        v('M99', '2025-10-13', 11712),
        v('M58', '2025-10-13', -11712),
        v('M100', '2025-10-13', -11765),
      ],
    })
    expect(planned).toEqual([
      expect.objectContaining({ journal_entry_id: 'M30', event_ids: ['sep-ranta', 'sep-ag', 'sep-prel', 'sep-skatt'] }),
      expect.objectContaining({
        journal_entry_id: 'M100',
        event_ids: ['okt-korr', 'okt-ranta', 'okt-ag', 'okt-prel', 'okt-skatt'],
      }),
    ])
  })

  it('refuses a split that does not fit at a change of date', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2026-03-05', 50), r('b', '2026-03-12', -17291), r('c', '2026-03-20', 10), r('d', '2026-04-12', -13753)],
      // Neither 50, 50-17291 nor 50-17291+10 is the first verifikat.
      entries: [v('M1', '2026-03-25', -17200), v('M2', '2026-04-12', -13784)],
    })
    expect(planned).toEqual([])
  })

  it('refuses verifikat that do not cancel evenly', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2026-03-12', -500)],
      entries: [v('X1', '2026-03-12', 500), v('X2', '2026-03-12', -500), v('X3', '2026-03-12', -500)],
    })
    expect(planned).toEqual([])
  })

  it('is exact to the öre', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2026-03-12', -17291), r('b', '2026-03-12', -13753)],
      entries: [v('M', '2026-03-12', -31044.01)],
    })
    expect(planned).toEqual([])
  })

  it('proposes nothing when the ledger holds no verifikat for the rows', () => {
    expect(
      planSkattekontoLedgerLinks({ rows: [r('a', '2026-03-12', -17291), r('b', '2026-04-12', -17291)], entries: [] }),
    ).toEqual([])
  })

  it('skips a segment with a row that cannot be linked, and keeps it out of later segments', () => {
    const july = month('jul', '2025-07-05', '2025-07-14', [-33682, -25746], 91)
    const aug = month('aug', '2025-08-02', '2025-08-18', [-16841, -12873], 74)
    const deadLinked = july.rows.map((row, i) => (i === 1 ? { ...row, linkable: false } : row))
    const planned = planSkattekontoLedgerLinks({ rows: [...deadLinked, ...aug.rows], entries: [july.entry, aug.entry] })
    expect(planned.map((p) => p.journal_entry_id)).toEqual(['M-aug'])
  })

  it('skips a reversed verifikat', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('a', '2026-03-12', -17291)],
      entries: [v('M', '2026-03-12', -17291, false)],
    })
    expect(planned).toEqual([])
  })

  it('stops at the N:1 link cap', () => {
    const rows = Array.from({ length: MAX_PLAN_ROWS_PER_ENTRY + 1 }, (_, i) => r(`row-${i}`, '2026-12-31', -100))
    const planned = planSkattekontoLedgerLinks({ rows, entries: [v('B1', '2026-12-31', -100 * rows.length)] })
    expect(planned).toEqual([])
    const fifty = rows.slice(0, MAX_PLAN_ROWS_PER_ENTRY)
    expect(
      planSkattekontoLedgerLinks({ rows: fifty, entries: [v('B1', '2026-12-31', -100 * fifty.length)] }),
    ).toHaveLength(1)
  })

  it('never proposes rows that only cancel each other, and links the interest the verifikat really holds', () => {
    // The payment in and the charges it paid are booked outside 1630 and
    // net to zero; the only verifikat on 1630 is the month's interest.
    const planned = planSkattekontoLedgerLinks({
      rows: [
        r('moms', '2025-09-12', -5579),
        r('ag', '2025-09-12', -5734),
        r('skatt', '2025-09-12', -9426),
        r('in', '2025-09-12', 20739),
        r('ranta', '2025-10-04', 1),
      ],
      entries: [v('R10', '2025-10-10', 1)],
    })
    expect(planned).toEqual([expect.objectContaining({ journal_entry_id: 'R10', event_ids: ['ranta'] })])
  })

  it('refuses a run with a part that nets to zero (the crm#1004 rule)', () => {
    // The 1630 verifikat holds the employer contribution, but the same day
    // also has a payment in equal to two other charges, booked elsewhere.
    const planned = planSkattekontoLedgerLinks({
      rows: [r('ag', '2026-03-12', -1306), r('skatt', '2026-03-12', -9426), r('prel', '2026-03-12', -5352), r('in', '2026-03-12', 14778)],
      entries: [v('X', '2026-03-12', -1306)],
    })
    expect(planned).toEqual([])
  })

  it('leaves rows that cancel each other on a day of their own out of the next link', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [
        r('ranta', '2025-10-04', 62),
        r('korr', '2025-10-04', -62),
        r('prel', '2025-10-13', -11393),
        r('skatt', '2025-10-13', -227),
      ],
      entries: [v('M', '2025-10-13', -11620)],
    })
    expect(planned).toEqual([expect.objectContaining({ journal_entry_id: 'M', event_ids: ['prel', 'skatt'] })])
  })

  it('ignores zero amounts on either side', () => {
    const planned = planSkattekontoLedgerLinks({
      rows: [r('zero', '2026-01-03', 0), r('a', '2026-01-19', -48187)],
      entries: [v('D2', '2026-01-01', 0), v('M', '2026-01-19', -48187)],
    })
    expect(planned).toEqual([expect.objectContaining({ journal_entry_id: 'M', event_ids: ['a'] })])
  })
})
