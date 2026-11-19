import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { includeAllState, setIncludeAll } from '../UnderlagImportWizard'

type Row = { id: string; selected: boolean; targetId: string | null }

const row = (id: string, selected: boolean, targetId: string | null): Row => ({ id, selected, targetId })

// A folder whose filenames carry no series lands every row on "Bekräfta"
// (needs_confirmation: one verifikat, not pre-ticked). Users ticked them one
// at a time, up to ~450 clicks in one session.
describe('underlag review: tick every row with a verifikat', () => {
  it('ticks every row that has a verifikat in one call', () => {
    const rows = [row('a', false, 'je-1'), row('b', false, 'je-2'), row('c', true, 'je-3')]
    const next = setIncludeAll(rows, true)
    expect(next.map((r) => r.selected)).toEqual([true, true, true])
    expect(includeAllState(next)).toBe('all')
  })

  it('never ticks a row without a verifikat (no match, locked year, ambiguous before a pick)', () => {
    const rows = [row('a', false, 'je-1'), row('locked', false, null), row('none', false, null)]
    const next = setIncludeAll(rows, true)
    expect(next.find((r) => r.id === 'locked')!.selected).toBe(false)
    expect(next.find((r) => r.id === 'none')!.selected).toBe(false)
    // The rows that cannot be ticked do not hold the header box at "some".
    expect(includeAllState(next)).toBe('all')
  })

  it('clears every ticked row', () => {
    const rows = [row('a', true, 'je-1'), row('b', true, 'je-2'), row('c', false, null)]
    const next = setIncludeAll(rows, false)
    expect(next.map((r) => r.selected)).toEqual([false, false, false])
    expect(includeAllState(next)).toBe('none')
  })

  it('keeps untouched rows as the same objects', () => {
    const ticked = row('a', true, 'je-1')
    const blocked = row('b', false, null)
    const next = setIncludeAll([ticked, blocked], true)
    expect(next[0]).toBe(ticked)
    expect(next[1]).toBe(blocked)
  })

  it('reads all, some or none for the header box', () => {
    expect(includeAllState([])).toBe('none')
    expect(includeAllState([row('a', false, null)])).toBe('none')
    expect(includeAllState([row('a', true, 'je-1'), row('b', false, 'je-2')])).toBe('some')
    expect(includeAllState([row('a', false, 'je-1'), row('b', false, 'je-2')])).toBe('none')
    expect(includeAllState([row('a', true, 'je-1'), row('b', true, 'je-2')])).toBe('all')
  })

  it('names the header box in both locales', () => {
    expect(sv.import.underlag_include_all).toBeTruthy()
    expect(en.import.underlag_include_all).toBeTruthy()
  })
})
