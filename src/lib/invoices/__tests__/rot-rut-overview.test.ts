import { describe, expect, it } from 'vitest'
import { readyTileOf } from '@/lib/invoices/rot-rut-overview'

/**
 * The "Redo att begäras" tile counts what a begäran file will take off the
 * list: ROT and RUT (the HUS file) and grön teknik (its own Begaran file).
 */
describe('readyTileOf', () => {
  it('counts grön teknik as ready next to ROT and RUT', () => {
    const tile = readyTileOf({ rot: 2, rut: 1, gron_teknik: 80 })
    expect(tile.ready).toBe(83)
    expect(tile.parts).toEqual([
      { kind: 'rot', count: 2 },
      { kind: 'rut', count: 1 },
      { kind: 'gron_teknik', count: 80 },
    ])
  })

  it('reads the grön teknik count for an installer with only grön teknik', () => {
    expect(readyTileOf({ rot: 0, rut: 0, gron_teknik: 160 })).toEqual({
      ready: 160,
      parts: [{ kind: 'gron_teknik', count: 160 }],
    })
  })

  it('lists only the kinds that have invoices, in ROT, RUT, grön teknik order', () => {
    expect(readyTileOf({ rot: 0, rut: 4, gron_teknik: 0 }).parts).toEqual([{ kind: 'rut', count: 4 }])
    expect(readyTileOf({ rot: 0, rut: 0, gron_teknik: 0 })).toEqual({ ready: 0, parts: [] })
  })
})
