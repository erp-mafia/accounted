import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { grossVat, splitGrossVat, treatmentForRate } from '../gross-split'

describe('splitGrossVat', () => {
  it('splits a VAT-inclusive amount into VAT and net', () => {
    expect(splitGrossVat(125, 0.25)).toEqual({ vat: 25, net: 100 })
    expect(splitGrossVat(112, 0.12)).toEqual({ vat: 12, net: 100 })
    expect(splitGrossVat(106, 0.06)).toEqual({ vat: 6, net: 100 })
  })

  it('rounds an exact half öre up (12 % on 0,42 kr is 4,5 öre)', () => {
    expect(splitGrossVat(0.42, 0.12)).toEqual({ vat: 0.05, net: 0.37 })
    expect(splitGrossVat(0.7, 0.12)).toEqual({ vat: 0.08, net: 0.62 })
  })

  it('has no VAT at a rate of 0 or below, or on 0 kr', () => {
    expect(splitGrossVat(100, 0)).toEqual({ vat: 0, net: 100 })
    expect(splitGrossVat(100, -0.25)).toEqual({ vat: 0, net: 100 })
    expect(splitGrossVat(0, 0.25)).toEqual({ vat: 0, net: 0 })
  })

  it('splits a refund as the mirror image of the sale', () => {
    for (const gross of [0.42, 0.7, 99.99, 1234.56]) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const sale = splitGrossVat(gross, rate)
        expect(splitGrossVat(-gross, rate)).toEqual({ vat: -sale.vat || 0, net: -sale.net || 0 })
      }
    }
  })

  it('net + vat is the gross to the öre', () => {
    for (let ore = 1; ore <= 20000; ore += 7) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const { vat, net } = splitGrossVat(ore / 100, rate)
        expect(Math.round(vat * 100) + Math.round(net * 100)).toBe(ore)
      }
    }
  })
})

// Parity with the copies it replaced, per formula:
//   Math.round(x * 100) / 100: generateInputVatLine (vat-entries), the
//     booking-template output VAT, the line-pattern VAT (counterparty-templates)
//     and the four prefill mirrors in proposal-lines (engineRound);
//   roundOre(x): category-mapping, template-library, the supplier-invoice
//     gross reading (line-totals) and the MCP foreign VAT in cost.
// with x = gross × rate / (1 + rate) in floating point. The one difference
// allowed: at 12 % an exact half öre (gross ≡ 14 mod 28 öre), where the old
// formulas rounded the float below the half down, the split now takes 1 öre
// more VAT. 25 % and 6 % have no exact halves and must not move at all.
describe('grossVat: parity with the copies it replaced', () => {
  const naive = (gross: number, rate: number) => Math.round(gross * rate / (1 + rate) * 100) / 100
  const ore = (gross: number, rate: number) => roundOre(gross * rate / (1 + rate))

  it.each([['Math.round', naive], ['roundOre', ore]] as const)('%s copies: identical except 12 %% exact halves, +1 öre', (_name, old) => {
    const moved: Record<string, number> = { '0.25': 0, '0.12': 0, '0.06': 0 }
    for (let g = 1; g <= 200000; g++) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const before = old(g / 100, rate)
        const after = grossVat(g / 100, rate)
        if (after === before) continue
        moved[String(rate)]++
        expect({ g, rate, exactHalf: rate === 0.12 && g % 28 === 14 }).toEqual({ g, rate, exactHalf: true })
        expect(Math.round((after - before) * 100)).toBe(1)
      }
    }
    expect(moved['0.25']).toBe(0)
    expect(moved['0.06']).toBe(0)
  })
})

describe('treatmentForRate', () => {
  it('maps the three Swedish rates and nothing else', () => {
    expect(treatmentForRate(0.25)).toBe('standard_25')
    expect(treatmentForRate(0.12)).toBe('reduced_12')
    expect(treatmentForRate(0.06)).toBe('reduced_6')
    expect(treatmentForRate(0)).toBeNull()
    expect(treatmentForRate(0.2)).toBeNull()
  })
})
