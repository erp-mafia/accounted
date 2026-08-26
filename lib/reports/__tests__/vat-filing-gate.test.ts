import { describe, it, expect } from 'vitest'
import {
  isFilingBlocked,
  rcBasisGapAdvisoryFinding,
  rcBasisGapFinding,
  rcBasisScanUnavailableFinding,
  rcBasisTotalsByRate,
  withRcBasisGapFindings,
  RC_BASIS_ACCOUNTS_BY_RATE,
  type RcBasisTotalsByRate,
  type RcGapDowngradeEvidence,
} from '../vat-filing-gate'
import type { VatDeclarationCheck } from '../vat-declaration-checks'
import type { VatDeclarationRutor } from '@/types'

function makeRutor(overrides: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor {
  return {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    ...overrides,
  }
}

function makeEvidence(
  rutor: Partial<VatDeclarationRutor>,
  basis: Partial<RcBasisTotalsByRate>,
): RcGapDowngradeEvidence {
  return {
    rutor: makeRutor(rutor),
    rcBasisByRate: { r25: 0, r12: 0, r6: 0, ...basis },
  }
}

const aggregateRcBasisMissing: VatDeclarationCheck = {
  code: 'RC_BASIS_MISSING',
  status: 'ERROR',
  message: 'aggregate finding',
}

const aggregateRcOutputMissing: VatDeclarationCheck = {
  code: 'RC_OUTPUT_MISSING',
  status: 'ERROR',
  message: 'aggregate surplus finding',
}

const warningOnly: VatDeclarationCheck = {
  code: 'RC_INPUT_VAT_MISMATCH',
  status: 'WARNING',
  message: 'warning finding',
}

describe('withRcBasisGapFindings', () => {
  it('leaves the list untouched when the scan found no gaps', () => {
    expect(withRcBasisGapFindings([], { status: 'scanned', gapCount: 0 })).toEqual([])
    expect(
      withRcBasisGapFindings([warningOnly], { status: 'scanned', gapCount: 0 }),
    ).toEqual([warningOnly])
  })

  it('says nothing while the scan is still in flight', () => {
    // Pending is not "inga brister", but it is not worth a row either: the
    // scan resolves in the same breath as the declaration itself.
    expect(withRcBasisGapFindings([], { status: 'pending' })).toEqual([])
  })

  it('adds a blocking finding when the aggregate check stayed silent', () => {
    // The filing hole: a 0.5% tolerance on a large period absorbs the whole
    // shortfall, so runVatDeclarationChecks returns [] while individual
    // verifikat still miss their basbelopp.
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 })
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('RC_BASIS_MISSING')
    expect(result[0].status).toBe('ERROR')
    expect(result[0].message).toContain('2 verifikationer')
  })

  it('keeps warnings and appends the gap finding after them', () => {
    const result = withRcBasisGapFindings([warningOnly], { status: 'scanned', gapCount: 1 })
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(warningOnly)
    expect(result[1].message).toContain('1 verifikation ')
  })

  it('does not duplicate the message when the aggregate check already fired', () => {
    const result = withRcBasisGapFindings([aggregateRcBasisMissing], {
      status: 'scanned',
      gapCount: 3,
    })
    expect(result).toEqual([aggregateRcBasisMissing])
  })

  it('does not mutate the input array', () => {
    const input: VatDeclarationCheck[] = [warningOnly]
    withRcBasisGapFindings(input, { status: 'scanned', gapCount: 4 })
    expect(input).toHaveLength(1)
  })
})

describe('withRcBasisGapFindings, correction-voucher tiering', () => {
  // The Orto Engineering case (2026-08): a refund correction chain left the
  // period per-rate identity exactly consistent while three moms-only
  // correction vouchers carried fiktiv moms whose basbelopp lived in other
  // (partly reversed) verifikat. No arrangement of vouchers can satisfy both
  // the per-voucher scan and the aggregate identity in that state, so an
  // ERROR was an unfixable block.
  it('downgrades gaps to WARNING when the per-rate basis matches the fiktiv moms', () => {
    const evidence = makeEvidence(
      { ruta21: 7750.36, ruta30: 1937.59 },
      { r25: 7750.36 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 3 }, evidence)
    expect(result).toHaveLength(1)
    // Same code so the Korrigera worklist in VatChecksCard stays visible.
    expect(result[0].code).toBe('RC_BASIS_MISSING')
    expect(result[0].status).toBe('WARNING')
    expect(result[0].message).toContain('rättelseverifikat')
    expect(isFilingBlocked(result)).toBe(false)
  })

  it('keeps blocking when the period has a real shortfall the aggregate tolerance absorbed', () => {
    // 400 000 kr implied basis, 1 500 kr missing: inside the aggregate 0.5%
    // tolerance (so checks is empty), but the declaration under-reports.
    // This is the original hole the module closes; it must survive the tiering.
    const evidence = makeEvidence(
      { ruta21: 398500, ruta30: 100000 },
      { r25: 398500 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 }, evidence)
    expect(result[0].status).toBe('ERROR')
    expect(isFilingBlocked(result)).toBe(true)
  })

  it('refutes the wrong-rate escape: a 25% basis cannot vouch for 12% fiktiv moms', () => {
    // /skeptic counterexample A: EU consulting booked with moms at 12%
    // (K 2624 12 000) while its 100 000 kr basis sits on 4535 (a 25% account).
    // The refuted cross-rate sum reached parity (100 000 covers 12 000/0.12);
    // per rate, the 12% moms has zero same-sats basis and the 25% basis has
    // zero same-sats moms, so both pairs fail and the gap keeps blocking.
    const evidence = makeEvidence(
      { ruta21: 100000, ruta31: 12000, ruta48: 4800 },
      { r25: 100000, r12: 0 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 1 }, evidence)
    expect(result[0].status).toBe('ERROR')
    expect(isFilingBlocked(result)).toBe(true)
  })

  it('refutes the negative-box escape: a net-negative rate refuses the downgrade', () => {
    // /skeptic counterexample B: ruta31 net negative (credit notes) made the
    // summed implied basis negative, so empty basis boxes "covered" it. Any
    // negative moms box now refuses the downgrade outright.
    const evidence = makeEvidence(
      { ruta30: 2500, ruta31: -1260 },
      { r25: 10000, r12: -10500 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 }, evidence)
    expect(result[0].status).toBe('ERROR')
    expect(isFilingBlocked(result)).toBe(true)
  })

  it('refuses the downgrade when RC_OUTPUT_MISSING already blocks the aggregate', () => {
    // /skeptic finding 3: an advisory claiming the underlag stämmer must never
    // render beside an aggregate ERROR asserting the opposite. The per-rate
    // identity nearly excludes this state mathematically; the guard makes it
    // impossible regardless.
    const evidence = makeEvidence(
      { ruta21: 7750.36, ruta30: 1937.59 },
      { r25: 7750.36 },
    )
    const result = withRcBasisGapFindings(
      [aggregateRcOutputMissing],
      { status: 'scanned', gapCount: 1 },
      evidence,
    )
    expect(result).toHaveLength(2)
    expect(result[1].status).toBe('ERROR')
  })

  it('keeps blocking when a surplus sits at the same rate as the gap', () => {
    // Same-rate surplus means some voucher is missing its fiktiv moms (the
    // RC_OUTPUT_MISSING defect): two-sided comparison refuses the downgrade
    // even before the aggregate ERROR is considered.
    const evidence = makeEvidence(
      { ruta21: 9000, ruta30: 1937.59 },
      { r25: 9000 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 1 }, evidence)
    expect(result[0].status).toBe('ERROR')
  })

  it('keeps blocking when the caller cannot supply evidence', () => {
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 })
    expect(result[0].status).toBe('ERROR')
  })

  it('öre drift does not flip the tier', () => {
    const evidence = makeEvidence(
      { ruta21: 7750.36, ruta30: 1937.59 },
      // 0.30 kr below the implied 7750.36: inside the öre epsilon.
      { r25: 7750.06 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 1 }, evidence)
    expect(result[0].status).toBe('WARNING')
  })

  it('drift just past the öre epsilon blocks: the 0.5 kr tolerance is pinned', () => {
    // 0.51 kr below the implied basis: one öre outside eps. This case exists
    // so a future widening of eps cannot slip through with every test green.
    const evidence = makeEvidence(
      { ruta21: 7750.36, ruta30: 1937.59 },
      { r25: 7749.85 },
    )
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 1 }, evidence)
    expect(result[0].status).toBe('ERROR')
  })

  it('malformed evidence blocks: a missing or non-numeric rate figure must not pass as NaN', () => {
    // The web view reads rcBasisByRate off unvalidated JSON. NaN compares
    // false to everything, so without the finite guard a malformed payload
    // would sail through every comparison and relax the gate.
    const rutor = makeRutor({ ruta21: 7750.36, ruta30: 1937.59 })
    const missingField = {
      rutor,
      rcBasisByRate: { r25: 7750.36 } as unknown as RcBasisTotalsByRate,
    }
    const nonNumeric = {
      rutor,
      rcBasisByRate: { r25: '7750.36', r12: 0, r6: 0 } as unknown as RcBasisTotalsByRate,
    }
    const nanMoms = {
      rutor: makeRutor({ ruta21: 7750.36, ruta30: Number.NaN }),
      rcBasisByRate: { r25: 7750.36, r12: 0, r6: 0 },
    }
    for (const evidence of [missingField, nonNumeric, nanMoms]) {
      const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 1 }, evidence)
      expect(result[0].status).toBe('ERROR')
      expect(isFilingBlocked(result)).toBe(true)
    }
  })
})

describe('rcBasisTotalsByRate', () => {
  it('groups net debit balances per momssats and rounds to öre', () => {
    const totals = new Map([
      ['4535', { debit: 1000.005, credit: 200 }],
      ['4515', { debit: 500, credit: 0 }],
      ['4536', { debit: 300, credit: 50 }],
      ['4517', { debit: 0, credit: 75 }],
      ['2614', { debit: 0, credit: 999 }], // not a basis account: ignored
    ])
    expect(rcBasisTotalsByRate(totals)).toEqual({
      r25: 1300.01,
      r12: 250,
      r6: -75,
    })
  })

  it('returns zeros for an empty map', () => {
    expect(rcBasisTotalsByRate(new Map())).toEqual({ r25: 0, r12: 0, r6: 0 })
  })

  it('covers all fifteen RC basis accounts exactly once across the rate groups', () => {
    const all = [
      ...RC_BASIS_ACCOUNTS_BY_RATE.r25,
      ...RC_BASIS_ACCOUNTS_BY_RATE.r12,
      ...RC_BASIS_ACCOUNTS_BY_RATE.r6,
    ]
    expect(new Set(all).size).toBe(15)
    expect([...all].sort()).toEqual([
      '4415', '4416', '4417',
      '4425', '4426', '4427',
      '4515', '4516', '4517',
      '4531', '4532', '4533',
      '4535', '4536', '4537',
    ])
  })
})

describe('rcBasisGapAdvisoryFinding', () => {
  it('uses singular and plural Swedish wording and keeps the worklist pointer', () => {
    expect(rcBasisGapAdvisoryFinding(1).message).toContain('1 verifikation i perioden')
    expect(rcBasisGapAdvisoryFinding(3).message).toContain('3 verifikationer i perioden')
    expect(rcBasisGapAdvisoryFinding(1).message).toContain('listan nedan')
    expect(rcBasisGapAdvisoryFinding(1).message).toContain('per momssats')
    expect(rcBasisGapAdvisoryFinding(1).status).toBe('WARNING')
    expect(rcBasisGapAdvisoryFinding(1).code).toBe('RC_BASIS_MISSING')
  })
})

describe('withRcBasisGapFindings, failed scan', () => {
  it('adds a non-blocking finding so the banner cannot claim all-clear', () => {
    // An empty check list renders as "Inga fel hittades i underlaget för
    // perioden". A scan that never answered has not earned that sentence.
    const result = withRcBasisGapFindings([], { status: 'unavailable' })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('WARNING')
    expect(isFilingBlocked(result)).toBe(false)
  })

  it('does not stack on top of a finding that already blocks', () => {
    const result = withRcBasisGapFindings([aggregateRcBasisMissing], { status: 'unavailable' })
    expect(result).toEqual([aggregateRcBasisMissing])
  })
})

describe('isFilingBlocked', () => {
  it('is false for an empty list and for warnings only', () => {
    expect(isFilingBlocked([])).toBe(false)
    expect(isFilingBlocked([warningOnly])).toBe(false)
  })

  it('is true for any ERROR', () => {
    expect(isFilingBlocked([warningOnly, aggregateRcBasisMissing])).toBe(true)
  })

  it('is true for a declaration whose only fault is unfixed gap verifikat', () => {
    // The regression this whole module exists for: banner and Skicka button
    // read the SAME folded array, so "inga fel" can no longer render above a
    // populated worklist with the send button enabled.
    const checks = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 })
    expect(checks.length).toBeGreaterThan(0)
    expect(isFilingBlocked(checks)).toBe(true)
  })
})

describe('rcBasisGapFinding', () => {
  it('names the boxes and the SKV rejection code so the user can act', () => {
    const finding = rcBasisGapFinding(1)
    expect(finding.message).toContain('ruta 20-24')
    expect(finding.message).toContain('FK004')
    expect(finding.rutor).toContain('ruta20')
  })

  it('uses singular and plural Swedish wording', () => {
    expect(rcBasisGapFinding(1).message).toContain('1 verifikation i perioden')
    expect(rcBasisGapFinding(5).message).toContain('5 verifikationer i perioden')
    expect(rcBasisGapFinding(1).message).toContain('Korrigera verifikationen')
    expect(rcBasisGapFinding(5).message).toContain('Korrigera verifikationerna')
  })
})

describe('rcBasisScanUnavailableFinding', () => {
  it('is a warning that admits it does not know, and points at the worklist', () => {
    const finding = rcBasisScanUnavailableFinding()
    expect(finding.status).toBe('WARNING')
    expect(finding.message).toContain('kunde inte köras')
    expect(finding.message).toContain('listan nedan')
  })
})
