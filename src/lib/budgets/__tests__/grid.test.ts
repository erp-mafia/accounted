/**
 * The /budget page's grid model: the sign flip happens once on the way in
 * and once on the way out, subtotals and the result are sums, and the save
 * sends only the cells that changed.
 */
import { describe, it, expect } from 'vitest'
import { changedCells, flipSign, groupGrid, rowTotal, toResultSign, withEdits, cellKey } from '../grid'

const MONTHS = ['2027-01', '2027-02', '2027-03']
const STORED = [
  { account_number: '3010', account_name: 'Försäljning', amounts: [-1000, -1000, 0] },
  { account_number: '5010', account_name: 'Lokalhyra', amounts: [300, 300, 300] },
]

describe('grid model', () => {
  it('shows the stored SIE amounts in the resultatrapport\'s sign, never -0', () => {
    expect(toResultSign(STORED).map((r) => r.amounts)).toEqual([
      [1000, 1000, 0],
      [-300, -300, -300],
    ])
    expect(Object.is(flipSign(0), 0)).toBe(true)
  })

  it('groups by class with subtotals, totals and the result', () => {
    const model = groupGrid(toResultSign(STORED), 3)
    expect(model.groups.map((g) => [g.account_class, g.subtotal, g.total])).toEqual([
      [3, [1000, 1000, 0], 2000],
      [5, [-300, -300, -300], -900],
    ])
    expect(model.result).toEqual([700, 700, -300])
    expect(model.resultTotal).toBe(1100)
  })

  it('lays edits and added accounts over the rows, sorted by account', () => {
    const rows = withEdits(
      toResultSign(STORED),
      new Map([[cellKey('3010', 2), 1500], [cellKey('4010', 0), -200]]),
      [{ account_number: '4010', account_name: 'Inköp' }],
      3,
    )
    expect(rows.map((r) => [r.account_number, r.amounts])).toEqual([
      ['3010', [1000, 1000, 1500]],
      ['4010', [-200, 0, 0]],
      ['5010', [-300, -300, -300]],
    ])
    expect(rowTotal(rows[0]!)).toBe(3500)
  })

  it('saves only changed cells, in the SIE sign, with the grid\'s tag; 0 removes', () => {
    const shown = toResultSign(STORED)
    const edits = new Map([
      [cellKey('3010', 0), 1000], // unchanged
      [cellKey('3010', 2), 1500.005], // new, rounded to öre
      [cellKey('5010', 1), 0], // removed
      [cellKey('4010', 0), -200], // added account
    ])
    expect(changedCells(shown, edits, MONTHS, { '6': 'H1' })).toEqual([
      { account_number: '3010', month: '2027-03', dimensions: { '6': 'H1' }, amount: -1500.01 },
      { account_number: '4010', month: '2027-01', dimensions: { '6': 'H1' }, amount: 200 },
      { account_number: '5010', month: '2027-02', dimensions: { '6': 'H1' }, amount: 0 },
    ])
  })
})
