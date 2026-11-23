import { describe, expect, it } from 'vitest'
import {
  attestRemainder,
  countThings,
  countUrgentThings,
  parseHemView,
  thingsOf,
  dayKindOf,
  dueStateOf,
  firstRows,
  groupNameParts,
  groupNames,
  groupRows,
  mergeLatest,
  queueWindow,
  shownRows,
  headlineOf,
  isUrgentRow,
  nextIsoDay,
  type NeedRowFacts,
} from '../need-model'

const TODAY = '2026-11-05'
const row = (key: string, extra: Partial<NeedRowFacts> = {}): NeedRowFacts => ({ key, group: 'pay', name: key, ...extra })

describe('headlineOf: one of five templates, counts only', () => {
  it('nothing waits: all clear', () => {
    expect(headlineOf(0, 0)).toEqual({ kind: 'clear', urgent: 0, rest: 0, total: 0 })
  })

  it.each([
    [1, 'one thing waits'],
    [16, 'many wait'],
  ])('nothing urgent, %i waiting (%s)', (total) => {
    expect(headlineOf(0, total)).toEqual({ kind: 'waiting', urgent: 0, rest: total, total })
  })

  it('one urgent and more behind it', () => {
    expect(headlineOf(1, 16)).toEqual({ kind: 'urgent', urgent: 1, rest: 15, total: 16 })
  })

  it('many urgent and one behind them', () => {
    expect(headlineOf(4, 5)).toEqual({ kind: 'urgent', urgent: 4, rest: 1, total: 5 })
  })

  it.each([1, 3])('only urgent rows (%i): nothing "till väntar"', (n) => {
    expect(headlineOf(n, n)).toEqual({ kind: 'urgent_only', urgent: n, rest: 0, total: n })
  })

  it('never counts more urgent rows than there are rows, and never below zero', () => {
    expect(headlineOf(9, 2)).toEqual({ kind: 'urgent_only', urgent: 2, rest: 0, total: 2 })
    expect(headlineOf(-1, -3)).toEqual({ kind: 'clear', urgent: 0, rest: 0, total: 0 })
  })

  it('an empty list for a company that has not got going is not_started, never clear', () => {
    expect(headlineOf(0, 0, false)).toEqual({ kind: 'not_started', urgent: 0, rest: 0, total: 0 })
  })

  it('rows that wait decide the headline whether or not the company has got going', () => {
    expect(headlineOf(0, 3, false)).toEqual({ kind: 'waiting', urgent: 0, rest: 3, total: 3 })
    expect(headlineOf(2, 3, false)).toEqual({ kind: 'urgent', urgent: 2, rest: 1, total: 3 })
  })
})

describe('dueStateOf and isUrgentRow', () => {
  it('reads a date against today', () => {
    expect(dueStateOf('2026-11-04', TODAY)).toBe('overdue')
    expect(dueStateOf('2026-11-05', TODAY)).toBe('today')
    expect(dueStateOf('2026-11-06', TODAY)).toBe('tomorrow')
    expect(dueStateOf('2026-11-12', TODAY)).toBe('later')
    expect(dueStateOf('2026-11-05T22:00:00Z', TODAY)).toBe('today')
  })

  it('has no state without a readable date', () => {
    expect(dueStateOf(null, TODAY)).toBeNull()
    expect(dueStateOf(undefined, TODAY)).toBeNull()
    expect(dueStateOf('snart', TODAY)).toBeNull()
  })

  it('tomorrow crosses a month and a year end', () => {
    expect(nextIsoDay('2026-11-30')).toBe('2026-12-01')
    expect(nextIsoDay('2026-12-31')).toBe('2027-01-01')
  })

  it('urgent is the data flag, or due by tomorrow', () => {
    expect(isUrgentRow(row('a', { urgent: true }), TODAY)).toBe(true)
    expect(isUrgentRow(row('b', { due: '2026-11-06' }), TODAY)).toBe(true)
    expect(isUrgentRow(row('c', { due: '2026-10-01' }), TODAY)).toBe(true)
    expect(isUrgentRow(row('d', { due: '2026-11-12' }), TODAY)).toBe(false)
    expect(isUrgentRow(row('e'), TODAY)).toBe(false)
  })
})

describe('firstRows: the rows that fall due soonest', () => {
  it('is empty when no row has a date or a flag', () => {
    expect(firstRows([], TODAY)).toEqual([])
    expect(firstRows([row('a'), row('b')], TODAY)).toEqual([])
  })

  it('returns the one dated row', () => {
    expect(firstRows([row('a'), row('b', { due: '2026-11-12' })], TODAY).map((r) => r.key)).toEqual(['b'])
  })

  it('orders by date, keeps three, and leaves undated rows out', () => {
    const rows = [
      row('late', { due: '2026-12-01' }),
      row('undated'),
      row('soon', { due: '2026-11-06' }),
      row('mid', { due: '2026-11-12' }),
      row('overdue', { due: '2026-10-30' }),
    ]
    expect(firstRows(rows, TODAY).map((r) => r.key)).toEqual(['overdue', 'soon', 'mid'])
  })

  it('a flagged row without a date counts as due today, in the order it came', () => {
    const rows = [row('flag', { urgent: true }), row('today', { due: TODAY }), row('old', { due: '2026-11-01' })]
    expect(firstRows(rows, TODAY).map((r) => r.key)).toEqual(['old', 'flag', 'today'])
  })

  it('honours the limit', () => {
    const rows = [row('a', { due: TODAY }), row('b', { due: TODAY })]
    expect(firstRows(rows, TODAY, 1).map((r) => r.key)).toEqual(['a'])
    expect(firstRows(rows, TODAY, 0)).toEqual([])
  })
})

describe('groupRows and groupNames', () => {
  it('groups in the fixed order and drops empty groups', () => {
    const rows = [row('w', { group: 'watch' }), row('p'), row('a', { group: 'attest' }), row('p2')]
    expect(groupRows(rows).map((g) => [g.group, g.rows.map((r) => r.key)])).toEqual([
      ['attest', ['a']],
      ['pay', ['p', 'p2']],
      ['watch', ['w']],
    ])
    expect(groupRows([])).toEqual([])
  })

  it('a group line is the names, cut after three', () => {
    expect(groupNames([])).toEqual({ shown: [], more: 0 })
    expect(groupNames(['Beijer'])).toEqual({ shown: ['Beijer'], more: 0 })
    expect(groupNames(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 })
    expect(groupNames(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
    expect(groupNames([' a ', '', 'b'], 1)).toEqual({ shown: ['a'], more: 1 })
  })
})

describe('parseHemView: ?vy= on "/"', () => {
  it('is Hem without a value or with one it does not know', () => {
    expect(parseHemView(undefined)).toBe('hem')
    expect(parseHemView('')).toBe('hem')
    expect(parseHemView('rutin')).toBe('hem')
    expect(parseHemView('BEHOVER')).toBe('hem')
  })

  it.each(['hem', 'borja', 'gjort'] as const)('reads %s', (view) => {
    expect(parseHemView(view)).toBe(view)
  })

  it('takes the first of a repeated parameter', () => {
    expect(parseHemView(['gjort', 'borja'])).toBe('gjort')
    expect(parseHemView([])).toBe('hem')
  })

  it('opens Hem for the list view it took over', () => {
    expect(parseHemView('behover')).toBe('hem')
  })
})

describe('counting things, not rows', () => {
  it('a row is one thing unless it says otherwise', () => {
    expect(thingsOf(row('a'))).toBe(1)
    expect(thingsOf(row('b', { things: 5 }))).toBe(5)
    expect(thingsOf(row('c', { things: 0 }))).toBe(0)
    expect(thingsOf(row('d', { things: -2 }))).toBe(0)
  })

  it('sums nothing, one, many and a mix', () => {
    expect(countThings([])).toBe(0)
    expect(countThings([row('a')])).toBe(1)
    expect(countThings([row('a', { things: 583 })])).toBe(583)
    expect(countThings([row('one'), row('five', { things: 5 }), row('subset', { things: 0 }), row('two', { things: 2 })])).toBe(8)
  })

  it('counts the urgent things of urgent rows only', () => {
    const rows = [
      row('calm', { things: 9, due: '2026-12-01' }),
      row('flag', { urgent: true }),
      row('five-overdue', { things: 5, due: '2026-10-06' }),
      row('five-two-overdue', { things: 5, urgentThings: 2, due: '2026-10-06' }),
      row('undated', { things: 3 }),
    ]
    expect(countUrgentThings([], TODAY)).toBe(0)
    expect(countUrgentThings([rows[0], rows[4]], TODAY)).toBe(0)
    expect(countUrgentThings([rows[1]], TODAY)).toBe(1)
    expect(countUrgentThings(rows, TODAY)).toBe(1 + 5 + 2)
  })

  it('never counts more urgent things than the row has', () => {
    expect(countUrgentThings([row('a', { things: 2, urgentThings: 7, urgent: true })], TODAY)).toBe(2)
  })

  it('the headline of a mixed list reads in things', () => {
    const rows = [row('pay', { things: 5, urgentThings: 5, due: '2026-10-06' }), row('attest', { things: 5 }), row('docs', { things: 583 })]
    expect(headlineOf(countUrgentThings(rows, TODAY), countThings(rows))).toEqual({ kind: 'urgent', urgent: 5, rest: 588, total: 593 })
  })
})

describe('attestRemainder', () => {
  it('is what the person rows do not already show', () => {
    expect(attestRemainder(0, 0)).toBe(0)
    expect(attestRemainder(5, 0)).toBe(5)
    expect(attestRemainder(5, 2)).toBe(3)
    expect(attestRemainder(2, 2)).toBe(0)
    expect(attestRemainder(1, 4)).toBe(0)
  })
})

describe('groupNameParts: a count follows a name where the title does not say it', () => {
  it('one row whose count is the title\'s count: the name alone', () => {
    expect(groupNameParts([{ ...row('a'), name: 'Leverantörsfakturor att attestera', count: 6, things: 6 }])).toEqual(['Leverantörsfakturor att attestera'])
  })

  it('one row the title counts as one thing (a backlog): the name with its number', () => {
    expect(groupNameParts([{ ...row('a'), name: 'Verifikat utan underlag', count: 587, things: 1 }])).toEqual(['Verifikat utan underlag (587)'])
  })

  it('several rows: each count row says its own number, a named row and a count of one do not', () => {
    expect(
      groupNameParts([
        { ...row('a'), name: 'Bokföra transaktioner', count: 22, things: 22 },
        { ...row('b'), name: 'Frister', count: 1, things: 1 },
        { ...row('c'), name: 'Anna' },
      ]),
    ).toEqual(['Bokföra transaktioner (22)', 'Frister', 'Anna'])
  })
})

describe('shownRows: a long group shows its first rows', () => {
  const many = Array.from({ length: 300 }, (_, i) => i)
  it('a short group is whole', () => {
    expect(shownRows([1, 2, 3], false, 10)).toEqual({ shown: [1, 2, 3], hidden: 0 })
  })
  it('never hides a lone row', () => {
    expect(shownRows(many.slice(0, 11), false, 10).hidden).toBe(0)
  })
  it('a long group is cut and says how many are hidden', () => {
    const cut = shownRows(many, false, 10)
    expect(cut.shown).toHaveLength(10)
    expect(cut.hidden).toBe(290)
  })
  it('open shows all', () => {
    expect(shownRows(many, true, 10)).toEqual({ shown: many, hidden: 0 })
  })
})

describe('mergeLatest: exactly the newest rows of two pages', () => {
  const when = (r: { at: string }) => r.at
  it('neither page full: everything, newest first', () => {
    expect(mergeLatest([[{ at: '2026-11-03' }, { at: '2026-11-01' }], [{ at: '2026-11-02' }]], 50, when).map(when)).toEqual(['2026-11-03', '2026-11-02', '2026-11-01'])
  })
  it('a full page hides what is older than its last row in the other page', () => {
    const full = [{ at: '2026-11-09' }, { at: '2026-11-08' }]
    const other = [{ at: '2026-11-10' }, { at: '2026-11-01' }]
    expect(mergeLatest([full, other], 2, when).map(when)).toEqual(['2026-11-10', '2026-11-09', '2026-11-08'])
  })
  it('both full: nothing older than the newer of the two last rows', () => {
    const a = [{ at: '2026-11-09' }, { at: '2026-11-05' }]
    const b = [{ at: '2026-11-08' }, { at: '2026-11-07' }]
    expect(mergeLatest([a, b], 2, when).map(when)).toEqual(['2026-11-09', '2026-11-08', '2026-11-07'])
  })
  it('empty pages', () => {
    expect(mergeLatest([[], []] as Array<Array<{ at: string }>>, 50, when)).toEqual([])
  })
})

describe('dayKindOf', () => {
  it.each([
    ['2026-11-05', 'today'],
    ['2026-11-04', 'yesterday'],
    ['2026-11-03', 'other'],
    ['2026-11-06', 'other'],
  ] as const)('%s against 2026-11-05 is %s', (day, kind) => {
    expect(dayKindOf(day, TODAY)).toBe(kind)
  })
  it('yesterday across a month', () => {
    expect(dayKindOf('2026-10-31', '2026-11-01')).toBe('yesterday')
  })
})

describe('queueWindow: the queue rows listed beside a step', () => {
  const rows = Array.from({ length: 300 }, (_, i) => i)
  it('a short group is whole', () => {
    expect(queueWindow([1, 2, 3], 1, 8)).toEqual({ shown: [1, 2, 3], before: 0, after: 0 })
  })
  it('a long group the step is not in: its first rows', () => {
    expect(queueWindow(rows, -1, 8)).toEqual({ shown: rows.slice(0, 8), before: 0, after: 292 })
  })
  it('around the step on screen', () => {
    const w = queueWindow(rows, 150, 8)
    expect(w.shown).toEqual(rows.slice(148, 156))
    expect(w.before + w.shown.length + w.after).toBe(300)
  })
  it('the last step stays in the window', () => {
    const w = queueWindow(rows, 299, 8)
    expect(w.shown).toContain(299)
    expect(w.after).toBe(0)
  })
})
