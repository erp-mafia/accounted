import { describe, it, expect } from 'vitest'
import { buildManualFilingRows } from '@/lib/reports/vat-manual-filing'
import type { VatDeclarationRutor } from '@/types'

/** All rutor zeroed; override the ones a case cares about. */
function makeRutor(overrides: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor {
  return {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0,
    ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    ...overrides,
  }
}

describe('buildManualFilingRows', () => {
  it('lists only populated rutor plus 48, and appends the 49 net last', () => {
    const rows = buildManualFilingRows(
      makeRutor({ ruta05: 100000, ruta10: 25000, ruta48: 3200 }),
    )
    expect(rows.map((r) => r.ruta)).toEqual(['05', '10', '48', '49'])
    // Untouched reverse-charge / EU rutor stay out.
    expect(rows.some((r) => r.ruta === '21')).toBe(false)
    const net = rows.at(-1)!
    expect(net).toMatchObject({ ruta: '49', label: 'Moms att betala', amount: 21800, isNet: true })
  })

  it('renders reverse-charge rutor when set', () => {
    const rows = buildManualFilingRows(
      makeRutor({ ruta21: 5000, ruta24: 2000, ruta30: 1250, ruta48: 1250 }),
    )
    expect(rows.map((r) => r.ruta)).toEqual(['21', '24', '30', '48', '49'])
    expect(rows.find((r) => r.ruta === '30')?.label).toBe('Utgående moms 25% (omvänd skattskyldighet)')
  })

  it('labels ruta 49 "att betala" when the net is positive', () => {
    const rows = buildManualFilingRows(makeRutor({ ruta10: 9300, ruta48: 0 }))
    expect(rows.at(-1)).toMatchObject({ ruta: '49', label: 'Moms att betala', amount: 9300 })
  })

  it('labels ruta 49 "att återfå" when the net is negative, with an absolute amount', () => {
    const rows = buildManualFilingRows(makeRutor({ ruta48: 4200 }))
    const net = rows.at(-1)!
    expect(net).toMatchObject({ ruta: '49', label: 'Moms att återfå', amount: 4200 })
    expect(net.amount).toBeGreaterThanOrEqual(0)
  })

  it('truncates each ruta to whole kronor (öretal faller bort) and recomputes ruta 49 from the truncated values', () => {
    // 252,50 kr output VAT -> 252 kr filed (öre dropped, SFL 22:1, not rounded
    // up to 253); net follows the truncated values.
    const rows = buildManualFilingRows(makeRutor({ ruta05: 1010, ruta10: 252.5, ruta48: 0 }))
    expect(rows.find((r) => r.ruta === '10')?.amount).toBe(252)
    expect(rows.at(-1)).toMatchObject({ ruta: '49', amount: 252 })
    // No öre anywhere.
    expect(rows.every((r) => Number.isInteger(r.amount))).toBe(true)
  })

  it('drops öre on the input ruta too, so a .9 input VAT does not round up the deduction', () => {
    // 100,90 kr input VAT -> 100 kr deducted; net = 300 output - 100 = 200.
    const rows = buildManualFilingRows(makeRutor({ ruta10: 300, ruta48: 100.9 }))
    expect(rows.find((r) => r.ruta === '48')?.amount).toBe(100)
    expect(rows.at(-1)).toMatchObject({ ruta: '49', amount: 200 })
  })

  it('keeps ruta 48 and 49 even when everything is zero', () => {
    const rows = buildManualFilingRows(makeRutor())
    expect(rows.map((r) => r.ruta)).toEqual(['48', '49'])
    expect(rows.at(-1)).toMatchObject({ ruta: '49', label: 'Moms att betala', amount: 0 })
  })

  it('orders rutor by ascending ruta number, with 49 always last (even past import rutor 60-62)', () => {
    const rows = buildManualFilingRows(makeRutor({ ruta10: 50, ruta60: 100, ruta48: 0 }))
    // 48 sorts to its numeric position (between 10 and 60); 49 is appended last.
    expect(rows.map((r) => r.ruta)).toEqual(['10', '48', '60', '49'])
    // Net includes import output VAT (ruta 60) per the SKV 4700 formula.
    expect(rows.at(-1)).toMatchObject({ ruta: '49', amount: 150 })
  })
})
