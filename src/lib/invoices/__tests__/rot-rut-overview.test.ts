import { describe, expect, it } from 'vitest'
import { readyTileOf } from '@/lib/invoices/rot-rut-overview'

/**
 * The "Redo att begäras" tile counts only what a begäran row will take off
 * the list: ROT and RUT. Grön teknik is requested in Skatteverkets e-tjänst,
 * which Accounted cannot see, so it is shown apart and never as "ready".
 */
describe('readyTileOf', () => {
  it('leaves grön teknik out of the ready count', () => {
    const tile = readyTileOf({ rot: 2, rut: 1, gronTeknikOpen: 80 })
    expect(tile.ready).toBe(3)
    expect(tile.gronTeknikOpen).toBe(80)
  })

  it('reads zero ready for an installer with only grön teknik', () => {
    expect(readyTileOf({ rot: 0, rut: 0, gronTeknikOpen: 160 })).toEqual({
      ready: 0,
      parts: [],
      gronTeknikOpen: 160,
    })
  })

  it('lists only the ROT/RUT kinds that have invoices, ROT first', () => {
    expect(readyTileOf({ rot: 0, rut: 4, gronTeknikOpen: 0 }).parts).toEqual([{ kind: 'rut', count: 4 }])
    expect(readyTileOf({ rot: 3, rut: 4, gronTeknikOpen: 0 }).parts).toEqual([
      { kind: 'rot', count: 3 },
      { kind: 'rut', count: 4 },
    ])
    expect(readyTileOf({ rot: 0, rut: 0, gronTeknikOpen: 0 }).parts).toEqual([])
  })
})
