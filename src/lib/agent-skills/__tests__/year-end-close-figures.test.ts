import { describe, it, expect } from 'vitest'
import { yearEndCloseSkill } from '../workflows/year-end-close'
import {
  ACCRUAL_LIMIT_SEK,
  ACCRUAL_LIMIT_FROM_BFNAR_2025_2_SEK,
} from '@/lib/bokslut/accruals/materiality'
import {
  CAPITALIZATION_THRESHOLD_YEARS,
  getCapitalizationThreshold,
} from '@/lib/bookkeeping/mapping-engine'

// The agent reads these figures as text; the code holds them as numbers.
// These checks fail when the two drift apart.

/** 29600 -> "29 600", the way the skill text writes amounts. */
function sek(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Every "N SEK" amount in a passage, whole numbers only. */
const AMOUNT = /(?<!\d)(?<!\d )(\d{1,3}(?: \d{3})*) SEK/g

const body = yearEndCloseSkill.body.replace(/\u00a0/g, ' ')

describe('year-end-close figures agree with the code', () => {
  it('the K2 accrual limits are the two the code applies', () => {
    const bullet = body.split('\n').find((line) => line.startsWith('- Under K2,'))
    expect(bullet).toBeDefined()
    const amounts = new Set([...bullet!.matchAll(AMOUNT)].map((m) => m[1]))
    expect(amounts).toEqual(new Set([sek(ACCRUAL_LIMIT_FROM_BFNAR_2025_2_SEK), sek(ACCRUAL_LIMIT_SEK)]))
  })

  describe('half prisbasbelopp', () => {
    const start = body.indexOf('half a prisbasbelopp (')
    const passage = start < 0 ? '' : body.slice(start, body.indexOf(')', start))
    const pairs = [...passage.matchAll(/(?<!\d)(?<!\d )(\d{1,3}(?: \d{3})*) SEK for (\d{4})/g)]
      .map((m) => ({ amount: m[1], year: Number(m[2]) }))

    it('matches the code for every year both know', () => {
      expect(pairs.length).toBeGreaterThan(0)
      for (const { amount, year } of pairs) {
        if (!CAPITALIZATION_THRESHOLD_YEARS.has(year)) continue
        expect(amount, `half prisbasbelopp ${year}`).toBe(sek(getCapitalizationThreshold(year)))
      }
    })

    it('covers the latest year the code knows', () => {
      const latest = Math.max(...CAPITALIZATION_THRESHOLD_YEARS)
      expect(pairs.map((p) => p.year)).toContain(latest)
    })
  })
})
