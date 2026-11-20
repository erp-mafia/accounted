import { describe, expect, it } from 'vitest'
import {
  BRF_DISCLOSURE_REQUIREMENTS,
  buildBrfForvaltningsberattelseFacts,
  energyExclusionStatements,
  validateBrfChapter38,
  type BrfChapter38Input,
} from '../chapter-38-disclosures'
import { buildBrfKeyRatioTable } from '../key-ratios'

function complete(overrides: Partial<BrfChapter38Input> = {}): BrfChapter38Input {
  return {
    privatbostadsforetag: true,
    markinnehav: 'aganderatt',
    tomtratt: null,
    samfallighet: { har_del: false, forvaltar: null },
    underhallsplan: { aktuell: true, teknisk_enligt_brl: true },
    nyckeltal_ej_representativa: null,
    energi_ej_i_arsavgift: { varme: false, el: true, vatten: false },
    forlust_finansiering: null,
    nettoomsattning: [
      { slag: 'Årsavgifter bostäder', belopp: 3_800_000 },
      { slag: 'Hyror lokaler', belopp: 200_000 },
    ],
    arsavgift_innehall: 'Värme, vatten och bredband ingår i årsavgiften.',
    ...overrides,
  }
}

const context = { arets_resultat: 120_000, nettoomsattning: 4_000_000 }

describe('K3 kapitel 38 facts', () => {
  it('passes a complete statement', () => {
    expect(validateBrfChapter38(complete(), context)).toEqual([])
  })

  it('requires every 38.2 statement, the tomträtt dates and what a samfällighet manages', () => {
    const codes = validateBrfChapter38(complete({
      privatbostadsforetag: null,
      markinnehav: 'tomtratt',
      tomtratt: { tidigast_uppsagning: '2041-03-31', avgaldsperiod_slut: null },
      samfallighet: { har_del: true, forvaltar: ' ' },
      underhallsplan: null,
    }), context).map((issue) => issue.code)
    expect(codes).toEqual([
      'BRF_PRIVATBOSTADSFORETAG_MISSING',
      'BRF_TOMTRATT_DATES_MISSING',
      'BRF_SAMFALLIGHET_FORVALTAR_MISSING',
      'BRF_UNDERHALLSPLAN_MISSING',
    ])
  })

  it('requires the financing statement only after a loss (ÅRL 6 kap. 3 a § andra stycket)', () => {
    expect(validateBrfChapter38(complete(), { ...context, arets_resultat: -1 }).map((i) => i.code))
      .toEqual(['BRF_FORLUST_FINANSIERING_MISSING'])
    expect(validateBrfChapter38(
      complete({ forlust_finansiering: 'Förlusten beror på planerat underhåll som finansieras med fonden.' }),
      { ...context, arets_resultat: -1 },
    )).toEqual([])
  })

  it('requires the nettoomsättning specification to add up to the resultaträkning (38.17)', () => {
    expect(validateBrfChapter38(complete(), { ...context, nettoomsattning: 4_000_001 }).map((i) => i.code))
      .toEqual(['BRF_NETTOOMSATTNING_DOES_NOT_TIE'])
    expect(validateBrfChapter38(complete({ nettoomsattning: [], arsavgift_innehall: null }), context).map((i) => i.code))
      .toEqual(['BRF_NETTOOMSATTNING_MISSING', 'BRF_ARSAVGIFT_INNEHALL_MISSING'])
  })

  it('lists the costs the årsavgift does not include (38.10 andra stycket)', () => {
    expect(energyExclusionStatements(complete())).toEqual(['el'])
  })

  it('bundles the facts with the key ratio table', () => {
    const facts = buildBrfForvaltningsberattelseFacts(complete(), buildBrfKeyRatioTable([]), context)
    expect(facts.issues).toEqual([])
    expect(facts.keyRatios.issues.map((i) => i.code)).toEqual(['BRF_KEY_RATIOS_FEWER_THAN_FOUR_YEARS'])
  })

  it('names a primary source for every requirement, each id once', () => {
    const ids = BRF_DISCLOSURE_REQUIREMENTS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const requirement of BRF_DISCLOSURE_REQUIREMENTS) expect(requirement.source).toMatch(/^(K3|ÅRL)/)
  })
})
