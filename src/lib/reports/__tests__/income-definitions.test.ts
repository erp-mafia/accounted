/**
 * One definition of nettoomsättning: the income statement, the K2 iXBRL
 * mapper and the INK2R mapping must agree on the RR revenue ranges. The
 * literal values are pinned too, so moving the K2 mapper onto the shared
 * constants cannot change a single filed amount.
 */
import { describe, it, expect } from 'vitest'
import {
  AKTIVERAT_ARBETE_RANGES,
  INCOME_STATEMENT_DEFINITIONS,
  NETTOOMSATTNING_RANGES,
  OVRIGA_RORELSEINTAKTER_RANGES,
  inAccountRanges,
} from '../income-definitions'
import { K2_RR_MAPPINGS } from '@/lib/bokslut/ixbrl/k2-mapper'
import { INK2R_ACCOUNT_MAPPINGS } from '../ink2/account-mappings'

const k2Ranges = (concept: string) =>
  K2_RR_MAPPINGS.find((m) => m.concept === concept)!.ranges
const ink2Ranges = (sruCode: string) =>
  INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === sruCode)!.accountRanges

describe('income definitions', () => {
  it('pins the statutory ranges to their pre-refactor literal values', () => {
    expect(NETTOOMSATTNING_RANGES).toEqual([{ start: '3000', end: '3799' }])
    expect(AKTIVERAT_ARBETE_RANGES).toEqual([{ start: '3800', end: '3899' }])
    expect(OVRIGA_RORELSEINTAKTER_RANGES).toEqual([{ start: '3900', end: '3999' }])
  })

  it('K2 iXBRL mapper uses exactly the shared ranges', () => {
    expect(k2Ranges('Nettoomsattning')).toEqual(NETTOOMSATTNING_RANGES)
    expect(k2Ranges('AktiveratArbeteEgenRakning')).toEqual(AKTIVERAT_ARBETE_RANGES)
    expect(k2Ranges('OvrigaRorelseintakter')).toEqual(OVRIGA_RORELSEINTAKTER_RANGES)
  })

  it('INK2R 7410/7412/7413 agree with the shared ranges', () => {
    expect(ink2Ranges('7410')).toEqual(NETTOOMSATTNING_RANGES)
    expect(ink2Ranges('7412')).toEqual(AKTIVERAT_ARBETE_RANGES)
    expect(ink2Ranges('7413')).toEqual(OVRIGA_RORELSEINTAKTER_RANGES)
  })

  it('the three lines partition class 3 with no gap or overlap', () => {
    for (let n = 3000; n <= 3999; n++) {
      const account = String(n)
      const hits = [NETTOOMSATTNING_RANGES, AKTIVERAT_ARBETE_RANGES, OVRIGA_RORELSEINTAKTER_RANGES]
        .filter((ranges) => inAccountRanges(account, ranges)).length
      expect(hits, account).toBe(1)
    }
  })

  it('treats egna uttag (34xx) as nettoomsättning', () => {
    expect(inAccountRanges('3401', NETTOOMSATTNING_RANGES)).toBe(true)
  })

  it('describes every figure with accounts and a definition', () => {
    for (const [key, def] of Object.entries(INCOME_STATEMENT_DEFINITIONS)) {
      expect(def.accounts, key).toMatch(/^\d{4}-\d{4}$/)
      expect(def.definition.length, key).toBeGreaterThan(10)
    }
  })
})
