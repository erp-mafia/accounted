import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { grossVat, HIGHEST_VAT_RATE, maxVatInGross, netVat, rateOfStatedVat, splitGrossVat, statedVatFitsRate, treatmentForRate, vatWithinGrossCeiling } from '../gross-split'

describe('netVat', () => {
  it('is the net times the rate', () => {
    expect(netVat(100, 0.25)).toBe(25)
    expect(netVat(100, 0.12)).toBe(12)
    expect(netVat(100, 0.06)).toBe(6)
    expect(netVat(333.33, 0.25)).toBe(83.33)
  })

  it('rounds an exact half öre up, whatever the binary float says', () => {
    expect(netVat(0.58, 0.25)).toBe(0.15) // 14,5 öre: Math.round(x * rate * 100) / 100 gave 0,14
    expect(netVat(2.75, 0.06)).toBe(0.17) // 16,5 öre: roundOre(x * rate) gave 0,16
    expect(netVat(571.3, 0.25)).toBe(142.83) // 142,825 kr, crm#1343
  })

  it('has no VAT at a rate of 0 or below, or on 0 kr', () => {
    expect(netVat(100, 0)).toBe(0)
    expect(netVat(100, -0.25)).toBe(0)
    expect(netVat(0, 0.25)).toBe(0)
    expect(Object.is(netVat(-0.001, 0.25), 0)).toBe(true)
  })

  it('takes the net to the öre first', () => {
    expect(netVat(100.004, 0.25)).toBe(25)
    expect(netVat(1.005, 0.25)).toBe(netVat(1.01, 0.25))
  })

  it('rounds a negative exact half toward plus infinity, as roundOre does', () => {
    expect(netVat(-0.5, 0.25)).toBe(-0.12)
    expect(netVat(-2.75, 0.06)).toBe(-0.16)
    expect(netVat(-100, 0.25)).toBe(-25)
  })

  it('takes any rate in basis points: a foreign seller\'s VAT too', () => {
    expect(netVat(100, 0.19)).toBe(19)
    expect(netVat(100, 0.055)).toBe(5.5)
  })

  it('leaves a rate finer than a basis point as stated, not rounded to one', () => {
    expect(netVat(10000, 0.09975)).toBe(997.5)
    expect(netVat(10000, 0.08875)).toBe(887.5)
  })

  // The sweeps compare in plain code and assert once: an expect() per amount
  // took about a second here and timed out at 5 s on a loaded CI runner.
  it('agrees with whole öre times basis points on every amount, both signs', () => {
    const differ: string[] = []
    for (let ore = 1; ore <= 300000; ore += 7) {
      for (const bp of [2500, 1200, 600]) {
        if (!Object.is(netVat(ore / 100, bp / 10000), Math.floor((ore * bp + 5000) / 10000) / 100)) {
          differ.push(`${ore} öre at ${bp} bp`)
        }
        if (!Object.is(netVat(-ore / 100, bp / 10000), Math.floor((-ore * bp + 5000) / 10000) / 100 + 0)) {
          differ.push(`-${ore} öre at ${bp} bp`)
        }
      }
    }
    expect(differ).toEqual([])
  })
})

describe('statedVatFitsRate', () => {
  it('takes the per-line rounding of an invoice: öre away from net × rate', () => {
    expect(statedVatFitsRate(0.24, 0.99, 0.25)).toBe(true) // 0,25 on the subtotal
    expect(statedVatFitsRate(250, 1000, 0.25)).toBe(true)
  })

  it('takes up to one krona either way, not more', () => {
    expect(statedVatFitsRate(26, 100, 0.25)).toBe(true)
    expect(statedVatFitsRate(24, 100, 0.25)).toBe(true)
    expect(statedVatFitsRate(26.01, 100, 0.25)).toBe(false)
    expect(statedVatFitsRate(23.99, 100, 0.25)).toBe(false)
  })

  it('refuses several rates or a momsfri part under one rate', () => {
    expect(statedVatFitsRate(37, 200, 0.25)).toBe(false) // 100 at 25 % + 100 at 12 %
    expect(statedVatFitsRate(25, 200, 0.25)).toBe(false) // half momsfri
  })
})

describe('rateOfStatedVat', () => {
  it('reads a stated VAT as the Swedish rate it is of the net', () => {
    expect(rateOfStatedVat(145, 580)).toBe(0.25)
    expect(rateOfStatedVat(77.68, 647.32)).toBe(0.12)
    expect(rateOfStatedVat(41.04, 683.96)).toBe(0.06)
  })

  it('reads no rate for a mixed invoice: 125 kr of moms on 725 kr', () => {
    expect(rateOfStatedVat(125, 600)).toBeNull()
  })

  it('takes the nearer of two rates that fit a small amount', () => {
    // 6 % of 4,72 kr is 0,28 kr; 25 % and 12 % are within a krona too.
    expect(rateOfStatedVat(0.28, 4.72)).toBe(0.06)
    expect(rateOfStatedVat(1.18, 4.72)).toBe(0.25)
  })

  it('reads nothing without moms or without a net', () => {
    expect(rateOfStatedVat(0, 100)).toBeNull()
    expect(rateOfStatedVat(25, 0)).toBeNull()
    expect(rateOfStatedVat(25, -100)).toBeNull()
  })
})

// What the copies it replaced answered, per formula, with x = net × rate in
// floating point. The invoice line form, roundOre(net * percent / 100), never
// moves. The others move up one öre, only on exact halves.
describe('netVat: parity with the copies it replaced', () => {
  const lineForm = (net: number, rate: number) => roundOre((net * (rate * 100)) / 100)
  const roundOreForm = (net: number, rate: number) => roundOre(net * rate)
  const naiveForm = (net: number, rate: number) => Math.round(net * rate * 100) / 100

  it.each([0.25, 0.12, 0.06])('the invoice line form never moves at %s', (rate) => {
    const moved: number[] = []
    for (let ore = 1; ore <= 300000; ore++) {
      if (!Object.is(lineForm(ore / 100, rate), netVat(ore / 100, rate))) moved.push(ore)
    }
    expect(moved).toEqual([])
  })

  it.each([['roundOre', roundOreForm], ['Math.round', naiveForm]] as const)('the %s form moves one öre up on exact halves, never at 12 %%', (_name, old) => {
    let moved = 0
    for (let ore = 1; ore <= 300000; ore++) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const before = old(ore / 100, rate)
        const after = netVat(ore / 100, rate)
        if (after === before) continue
        moved++
        expect((ore * Math.round(rate * 10000)) % 10000).toBe(5000)
        expect(rate).not.toBe(0.12)
        expect(Math.round((after - before) * 100)).toBe(1)
      }
    }
    expect(moved).toBeGreaterThan(0)
  })
})

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

describe('vatWithinGrossCeiling: the ceiling for a document\'s moms', () => {
  it('the ceiling is the 25 % share of the gross, which is 25 % of the net', () => {
    expect(HIGHEST_VAT_RATE).toBe(0.25)
    expect(maxVatInGross(125)).toBe(25)
    expect(maxVatInGross(-125)).toBe(25)
    expect(maxVatInGross(1230.97)).toBe(246.19)
    expect(maxVatInGross(0)).toBe(0)
  })

  it('accepts moms at the exact boundary and refuses one öre above it', () => {
    expect(vatWithinGrossCeiling(25, 125)).toBe(true)
    expect(vatWithinGrossCeiling(25.01, 125)).toBe(false)
    expect(vatWithinGrossCeiling(246.19, 1230.97)).toBe(true)
    expect(vatWithinGrossCeiling(246.2, 1230.97)).toBe(false)
  })

  it('takes the sign of the gross away: an expense row is a negative amount', () => {
    expect(vatWithinGrossCeiling(25, -125)).toBe(true)
    expect(vatWithinGrossCeiling(25.01, -125)).toBe(false)
  })

  it('compares in whole öre, so float noise on the boundary does not refuse it', () => {
    expect(vatWithinGrossCeiling(0.1 + 0.2, 1.5)).toBe(true) // 0,30000000000000004 on a ceiling of 0,30
    expect(vatWithinGrossCeiling(roundOre(24.996), 125)).toBe(true)
    expect(vatWithinGrossCeiling(25.004, 125)).toBe(true)
    expect(vatWithinGrossCeiling(25.005, 125)).toBe(false)
  })

  it('accepts a lower or mixed-rate moms and refuses a misread', () => {
    expect(vatWithinGrossCeiling(12, 112)).toBe(true)
    expect(vatWithinGrossCeiling(18.5, 125)).toBe(true)
    expect(vatWithinGrossCeiling(125, 125)).toBe(false)
    expect(vatWithinGrossCeiling(1, 0)).toBe(false)
  })
})
