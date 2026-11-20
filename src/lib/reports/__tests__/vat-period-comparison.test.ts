import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import {
  compareVatPeriods,
  RATE_SHARE_SHIFT_MIN_POINTS,
  VAT_SANITY_FLOOR_KRONOR,
  type VatSanityRutor,
} from '../vat-period-comparison'

/** A period's rutor from its taxable base per rate: ruta 05 the bases, rutor 10-12 the output VAT. */
function sales({ at25 = 0, at12 = 0, at6 = 0 }: { at25?: number; at12?: number; at6?: number }): VatSanityRutor {
  return {
    ruta05: roundOre(at25 + at12 + at6),
    ruta10: roundOre(at25 * 0.25),
    ruta11: roundOre(at12 * 0.12),
    ruta12: roundOre(at6 * 0.06),
  }
}

/** The ratio the old check compared: ruta 10 / ruta 05, and the relative drift that fired above 20 %. */
function oldRatioDriftPct(current: VatSanityRutor, previous: VatSanityRutor): number {
  const cur = compareVatPeriods(current, null).ratios.output_vat_ratio_25
  const prev = compareVatPeriods(previous, null).ratios.output_vat_ratio_25
  return roundOre(((cur - prev) / prev) * 100)
}

describe('compareVatPeriods', () => {
  describe('the worked example in #129: a sales-mix change across 25 % and 12 %', () => {
    const smallMix = sales({ at25: 100_000, at12: 400_000 })
    const largeMix = sales({ at25: 100_000, at12: 900_000 })

    it('stays quiet, in either direction, where the ruta 10 / ruta 05 ratio fired', () => {
      // The old check: a 50 % or 100 % relative drift, far above its 20 %.
      expect(oldRatioDriftPct(largeMix, smallMix)).toBe(-50)
      expect(oldRatioDriftPct(smallMix, largeMix)).toBe(100)

      expect(compareVatPeriods(smallMix, largeMix).anomalies).toEqual([])
      expect(compareVatPeriods(largeMix, smallMix).anomalies).toEqual([])
    })

    it('reports each rate share of the taxable base derived from output VAT', () => {
      const { ratios } = compareVatPeriods(smallMix, largeMix)
      expect(ratios.rate_shares).toEqual({
        current: { '25': 20, '12': 80, '6': 0 },
        previous: { '25': 10, '12': 90, '6': 0 },
      })
      expect(ratios.previous_period_compared).toBe(true)
    })

    it('keeps the deprecated fields as they were: ruta 10 / ruta 05 in percent, 12 and 6 at 0', () => {
      const { ratios } = compareVatPeriods(smallMix, largeMix)
      expect(ratios.output_vat_ratio_25).toBe(5)
      expect(ratios.output_vat_ratio_12).toBe(0)
      expect(ratios.output_vat_ratio_6).toBe(0)
    })
  })

  it('fires when lodging is booked at 25 % instead of 12 %: one anomaly per rate that moved', () => {
    const previous = sales({ at25: 100_000, at12: 400_000 })
    const current = sales({ at25: 500_000 })

    const { anomalies } = compareVatPeriods(current, previous)

    expect(anomalies).toEqual([
      expect.objectContaining({
        kind: 'rate_share_shift',
        rate: '25',
        current: 100,
        previous: 20,
        delta_pct: 80,
        current_base: 500_000,
        previous_base: 100_000,
      }),
      expect.objectContaining({
        kind: 'rate_share_shift',
        rate: '12',
        current: 0,
        previous: 80,
        delta_pct: -80,
        current_base: 0,
        previous_base: 400_000,
      }),
    ])
    expect(anomalies[0].message).toMatch(/^Andelen av försäljningen med 25 % moms steg från 20 % till 100 %/)
    expect(anomalies[0].message).toContain('ökade med 400')
    expect(anomalies[1].message).toMatch(/12 % moms föll från 80 % till 0 %/)
    // Ruta 05 is unchanged, so no revenue anomaly rides along.
    expect(anomalies.some((a) => a.kind !== 'rate_share_shift')).toBe(false)
  })

  it('names only the rate that moved when another rate grows on its own', () => {
    // The 12 % share halves, but its base did not move: only 25 % grew.
    const previous = sales({ at12: 500_000 })
    const current = sales({ at25: 500_000, at12: 500_000 })

    const { anomalies } = compareVatPeriods(current, previous)

    expect(anomalies.map((a) => [a.kind, a.rate])).toEqual([['rate_share_shift', '25']])
  })

  it('fires at exactly the share threshold when the base moves enough', () => {
    const previous = sales({ at25: 250_000, at12: 250_000 })
    const current = sales({ at25: 325_000, at12: 175_000 })

    const { anomalies } = compareVatPeriods(current, previous)

    expect(anomalies.map((a) => [a.rate, a.delta_pct])).toEqual([
      ['25', RATE_SHARE_SHIFT_MIN_POINTS],
      ['12', -RATE_SHARE_SHIFT_MIN_POINTS],
    ])
  })

  it('stays quiet one step under the share threshold', () => {
    const previous = sales({ at25: 250_000, at12: 250_000 })
    const current = sales({ at25: 324_000, at12: 176_000 })
    expect(compareVatPeriods(current, previous).anomalies).toEqual([])
  })

  describe('a small 6 % amount stays quiet', () => {
    it('when its share barely moves', () => {
      const previous = sales({ at25: 400_000 })
      const current = sales({ at25: 400_000, at6: 10_000 })
      expect(compareVatPeriods(current, previous).anomalies).toEqual([])
    })

    it('when its share moves a lot but its base moves less than the krona floor', () => {
      // 6 % goes from 0 to 28.6 % of sales, on 12 000 kr.
      const previous = sales({ at25: 30_000 })
      const current = sales({ at25: 30_000, at6: 12_000 })

      const result = compareVatPeriods(current, previous)

      expect(result.ratios.rate_shares.current?.['6']).toBe(28.57)
      expect(result.anomalies).toEqual([])
    })
  })

  it('does not compare shares when a period is below the floor, but still reports the revenue spike', () => {
    const previous = sales({ at12: VAT_SANITY_FLOOR_KRONOR - 1_000 })
    const current = sales({ at25: 100_000 })

    const { anomalies } = compareVatPeriods(current, previous)

    expect(anomalies.map((a) => a.kind)).toEqual(['revenue_spike'])
  })

  describe('revenue_drop and revenue_spike', () => {
    it('2 000 kr to 7 000 kr is not a spike', () => {
      expect(compareVatPeriods(sales({ at25: 7_000 }), sales({ at25: 2_000 })).anomalies).toEqual([])
    })

    it('10 000 kr to 40 000 kr is', () => {
      const { anomalies } = compareVatPeriods(sales({ at25: 40_000 }), sales({ at25: 10_000 }))
      expect(anomalies).toEqual([
        expect.objectContaining({ kind: 'revenue_spike', current: 40_000, previous: 10_000, delta_pct: 300 }),
      ])
      expect(anomalies[0].message).toMatch(/^Försäljningen i ruta 05 steg 300 %/)
    })

    it('a fall from 60 000 kr to 20 000 kr is a drop', () => {
      const { anomalies } = compareVatPeriods(sales({ at25: 20_000 }), sales({ at25: 60_000 }))
      expect(anomalies).toEqual([
        expect.objectContaining({ kind: 'revenue_drop', current: 20_000, previous: 60_000, delta_pct: -66.67 }),
      ])
      expect(anomalies[0].message).toMatch(/^Försäljningen i ruta 05 föll 66,7 %/)
    })

    it('a fall from 20 000 kr to 0 kr is under the floor', () => {
      expect(compareVatPeriods(sales({}), sales({ at25: 20_000 })).anomalies).toEqual([])
    })
  })

  describe('negative rutor (credit notes exceeding sales) and empty periods', () => {
    it('leaves the shares out when a rate is negative, without NaN anywhere', () => {
      const previous = sales({ at25: 100_000, at12: 400_000 })
      const current = sales({ at25: 300_000, at12: -50_000 })

      const result = compareVatPeriods(current, previous)

      expect(result.ratios.rate_shares.current).toBeNull()
      expect(result.anomalies.filter((a) => a.kind === 'rate_share_shift')).toEqual([])
      expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/)
    })

    it('skips the revenue comparison when the previous ruta 05 is negative', () => {
      const previous: VatSanityRutor = { ruta05: -40_000, ruta10: -10_000, ruta11: 0, ruta12: 0 }
      const result = compareVatPeriods(sales({ at25: 100_000 }), previous)
      expect(result.anomalies).toEqual([])
      expect(result.ratios.rate_shares.previous).toBeNull()
    })

    it('handles an empty previous period: compared, nothing to share, nothing fires', () => {
      const result = compareVatPeriods(sales({ at25: 100_000, at12: 50_000 }), sales({}))

      expect(result.anomalies).toEqual([])
      expect(result.ratios.previous_period_compared).toBe(true)
      expect(result.ratios.rate_shares.previous).toBeNull()
      expect(result.ratios.rate_shares.current).toEqual({ '25': 66.67, '12': 33.33, '6': 0 })
    })

    it('handles an empty current period without dividing by zero', () => {
      const result = compareVatPeriods(sales({}), sales({ at25: 100_000 }))

      expect(result.ratios.rate_shares.current).toBeNull()
      expect(result.ratios.output_vat_ratio_25).toBe(0)
      expect(result.anomalies.map((a) => a.kind)).toEqual(['revenue_drop'])
    })

    it('says so when the previous period could not be read', () => {
      const result = compareVatPeriods(sales({ at25: 100_000 }), null)

      expect(result.anomalies).toEqual([])
      expect(result.ratios.previous_period_compared).toBe(false)
      expect(result.ratios.rate_shares.previous).toBeNull()
    })
  })
})
