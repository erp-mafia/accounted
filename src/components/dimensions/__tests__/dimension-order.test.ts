import { describe, it, expect } from 'vitest'
import { placementOf, planDimensionReorder, type OrderedDimension } from '../dimension-order'

// A fresh registry as the API lists it: the seeded system pair at 10/20 and
// two custom dimensions sharing the create default of 100 (tie broken by SIE
// number, so Region #20 lists before Kund #21).
const seeded: OrderedDimension[] = [
  { id: 'ks', sort_order: 10 },
  { id: 'proj', sort_order: 20 },
  { id: 'region', sort_order: 100 },
  { id: 'kund', sort_order: 100 },
]

/** Applies the writes and re-sorts by sort_order the way the register does (stable on ties). */
function applyWrites(ordered: OrderedDimension[], writes: { id: string; sort_order: number }[]): string[] {
  const byId = new Map(writes.map((w) => [w.id, w.sort_order]))
  return ordered
    .map((d, index) => ({ id: d.id, sort_order: byId.get(d.id) ?? d.sort_order, index }))
    .sort((a, b) => a.sort_order - b.sort_order || a.index - b.index)
    .map((d) => d.id)
}

describe('placementOf', () => {
  it('names the dimension listed right before', () => {
    expect(placementOf(seeded, 'region')).toBe('proj')
    expect(placementOf(seeded, 'kund')).toBe('region')
  })

  it('is null for the first dimension and for an unknown id', () => {
    expect(placementOf(seeded, 'ks')).toBeNull()
    expect(placementOf(seeded, 'missing')).toBeNull()
  })
})

describe('planDimensionReorder', () => {
  it('writes nothing when the placement keeps the current order', () => {
    expect(planDimensionReorder(seeded, 'region', 'proj')).toEqual([])
    expect(planDimensionReorder(seeded, 'ks', null)).toEqual([])
    // Ties are left alone as long as nothing moves.
    expect(planDimensionReorder(seeded, 'kund', 'region')).toEqual([])
  })

  it('moves a custom dimension first and renumbers only the rows that change', () => {
    const writes = planDimensionReorder(seeded, 'kund', null)
    expect(writes).toEqual([
      { id: 'kund', sort_order: 1 },
      { id: 'ks', sort_order: 2 },
      { id: 'proj', sort_order: 3 },
      { id: 'region', sort_order: 4 },
    ])
    expect(applyWrites(seeded, writes)).toEqual(['kund', 'ks', 'proj', 'region'])
  })

  it('breaks a sort_order tie in the requested direction', () => {
    // Kund after Region is the tie's current order; Region after Kund must
    // give the two distinct numbers, not swap two equal ones.
    const writes = planDimensionReorder(seeded, 'region', 'kund')
    expect(applyWrites(seeded, writes)).toEqual(['ks', 'proj', 'kund', 'region'])
    expect(new Set(writes.map((w) => w.sort_order)).size).toBe(writes.length)
  })

  it('moves a system dimension, which the route allows', () => {
    const writes = planDimensionReorder(seeded, 'ks', 'region')
    expect(applyWrites(seeded, writes)).toEqual(['proj', 'region', 'ks', 'kund'])
  })

  it('skips rows already on their new number', () => {
    const renumbered: OrderedDimension[] = [
      { id: 'ks', sort_order: 1 },
      { id: 'proj', sort_order: 2 },
      { id: 'region', sort_order: 3 },
      { id: 'kund', sort_order: 4 },
    ]
    expect(planDimensionReorder(renumbered, 'kund', 'proj')).toEqual([
      { id: 'kund', sort_order: 3 },
      { id: 'region', sort_order: 4 },
    ])
  })

  it('refuses unknown ids and placing a dimension after itself', () => {
    expect(planDimensionReorder(seeded, 'missing', null)).toEqual([])
    expect(planDimensionReorder(seeded, 'region', 'missing')).toEqual([])
    expect(planDimensionReorder(seeded, 'region', 'region')).toEqual([])
  })
})
