import { describe, it, expect } from 'vitest'
import type { VatDeclarationRutor } from '@/types'
import { runVatDeclarationChecks } from '../vat-declaration-checks'

const emptyRutor: VatDeclarationRutor = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

describe('runVatDeclarationChecks', () => {
  it('returns empty findings for a balanced sales-only declaration', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 100000,
      ruta10: 25000,
      ruta49: 25000,
    }
    expect(runVatDeclarationChecks(rutor)).toEqual([])
  })

  it('returns empty findings for a balanced declaration with RC basis + output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 10000, // EU services basis
      ruta30: 2500,  // RC output VAT
      ruta48: 2500,  // matching input VAT
      ruta49: 0,
    }
    expect(runVatDeclarationChecks(rutor)).toEqual([])
  })

  // FK004 mirror: SKV's primary rejection signal we want to catch locally.
  it('flags ERROR when ruta 30-32 populated but ruta 20-24 is empty', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 78852,
      ruta10: 19713,
      ruta30: 2500,
      ruta48: 2500,
      ruta49: 19713,
    }
    const findings = runVatDeclarationChecks(rutor)
    const fk004 = findings.find((f) => f.code === 'RC_BASIS_MISSING')
    expect(fk004).toBeDefined()
    expect(fk004?.status).toBe('ERROR')
    expect(fk004?.message).toMatch(/ruta 30-32/)
    expect(fk004?.message).toMatch(/ruta 20-24/)
  })

  // Regression (2026-07-24): the check compared presence, not proportion, so
  // correcting ONE voucher out of ~39 cleared the error while ~51 tkr of
  // basis was still missing and the declaration claimed to be ready.
  it('flags ERROR when RC basis is only partially reported', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 2109.16,   // one corrected voucher
      ruta30: 13446.18,  // fiktiv moms for ~39 vouchers → expects ~53 785 kr basis
      ruta48: 13446.18,
      ruta49: 0,
    }
    const finding = runVatDeclarationChecks(rutor).find((f) => f.code === 'RC_BASIS_MISSING')
    expect(finding?.status).toBe('ERROR')
    expect(finding?.message).toMatch(/saknas/)
  })

  it('does not flag RC basis inside the per-voucher rounding tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 9990, // expected 10000, tolerance max(1, 0.5%) = 50
      ruta30: 2500,
      ruta48: 2500,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'RC_BASIS_MISSING')).toBeUndefined()
    expect(findings.find((f) => f.code === 'RC_OUTPUT_MISSING')).toBeUndefined()
  })

  it('flags ERROR when a whole voucher of basis is missing beyond the tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 9000, // expected 10000: one ~1000 kr voucher missing
      ruta30: 2500,
      ruta48: 2500,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(rutor).find((f) => f.code === 'RC_BASIS_MISSING')?.status,
    ).toBe('ERROR')
  })

  it('flags ERROR when basis exceeds what the output VAT accounts for', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 60000, // expected only 10000 from ruta30: fiktiv moms missing
      ruta30: 2500,
      ruta48: 2500,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(rutor).find((f) => f.code === 'RC_OUTPUT_MISSING')?.status,
    ).toBe('ERROR')
  })

  it('flags ERROR when basis is present but no output RC VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 10000,
      ruta48: 2500,
      ruta49: -2500,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'RC_OUTPUT_MISSING')?.status).toBe('ERROR')
  })

  it('warns when input VAT is materially smaller than RC output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 10000,
      ruta30: 2500,
      ruta48: 100, // Calculated input VAT missing: should be ~2500
      ruta49: 2400,
    }
    const findings = runVatDeclarationChecks(rutor)
    const mismatch = findings.find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')
    expect(mismatch?.status).toBe('WARNING')
  })

  // The finding this pair of tests exists for: ruta 48 aggregates 2641 + 2642 +
  // 2645 + 2646 + 2647 + 2649, so ordinary debiterad ingående moms masked a
  // completely missing RC input. 50 000 kr of RC output with nothing on 2645,
  // next to 60 000 kr of ordinary 2641, left ruta 48 (60 000) above the RC
  // output (50 000) and the aggregate comparison silent, while the company paid
  // in 50 000 kr it was entitled to deduct.
  describe('RC_INPUT_VAT_MISMATCH against the RC input accounts', () => {
    const rcTotals = (accounts: Record<string, number>) =>
      new Map(Object.entries(accounts).map(([acc, debit]) => [acc, { debit, credit: 0 }]))

    it('warns when RC output has no 2645/2647 behind it even though ruta 48 is larger', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta21: 200000, // 50 000 / 0.25: basis correctly booked, so no FK004
        ruta30: 50000,  // fiktiv utgående moms
        ruta48: 60000,  // ordinary 2641 only: no RC input at all
        ruta49: -10000,
      }
      const totals = rcTotals({ '2641': 60000 })

      // Aggregate-only comparison: silent, which is the bug.
      expect(
        runVatDeclarationChecks(rutor).find((f) => f.code === 'RC_INPUT_VAT_MISMATCH'),
      ).toBeUndefined()

      const finding = runVatDeclarationChecks(rutor, totals)
        .find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')
      expect(finding?.status).toBe('WARNING')
      // \s, not a literal space: sv-SE groups thousands with a no-break space.
      expect(finding?.message).toMatch(/50\s000 kr/)
      expect(finding?.message).toMatch(/saknas/)
    })

    it('does not warn for a correct RC declaration where 2645 mirrors the output', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta21: 200000,
        ruta30: 50000,
        ruta48: 110000, // 60 000 ordinary 2641 + 50 000 RC input
        ruta49: -60000,
      }
      const totals = rcTotals({ '2641': 60000, '2645': 50000 })
      expect(
        runVatDeclarationChecks(rutor, totals).find((f) => f.code === 'RC_INPUT_VAT_MISMATCH'),
      ).toBeUndefined()
    })

    it('accepts 2647 (domestic reverse charge) as the mirror', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta24: 200000, // domestic RC services, ML 16 kap
        ruta30: 50000,
        ruta48: 50000,
        ruta49: 0,
      }
      expect(
        runVatDeclarationChecks(rutor, rcTotals({ '2647': 50000 }))
          .find((f) => f.code === 'RC_INPUT_VAT_MISMATCH'),
      ).toBeUndefined()
    })

    it('warns on a partial RC input shortfall the aggregate cannot see', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta21: 200000,
        ruta30: 50000,
        ruta48: 80000, // 60 000 ordinary + only 20 000 of the 50 000 RC input
        ruta49: -30000,
      }
      const totals = rcTotals({ '2641': 60000, '2645': 20000 })
      expect(
        runVatDeclarationChecks(rutor).find((f) => f.code === 'RC_INPUT_VAT_MISMATCH'),
      ).toBeUndefined()
      const finding = runVatDeclarationChecks(rutor, totals)
        .find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')
      expect(finding?.status).toBe('WARNING')
      expect(finding?.message).toMatch(/30\s000 kr saknas/)
    })

    it('leaves a declaration with no reverse charge at all untouched', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 400000,
        ruta10: 100000,
        ruta48: 60000, // ordinary input VAT only, no rutor 30-32
        ruta49: 40000,
      }
      const totals = rcTotals({ '2641': 60000 })
      expect(runVatDeclarationChecks(rutor, totals)).toEqual([])
      expect(runVatDeclarationChecks(rutor)).toEqual([])
    })

    // 2649 carries the deductible portion of shared costs in general, not RC
    // input; counting it would put the masking back.
    it('does not count 2649 (blandad verksamhet) as reverse-charge input', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta21: 200000,
        ruta30: 50000,
        ruta48: 50000,
        ruta49: 0,
      }
      expect(
        runVatDeclarationChecks(rutor, rcTotals({ '2649': 50000 }))
          .find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')?.status,
      ).toBe('WARNING')
    })

    // A credit on 2645 (e.g. a storno of the fiktiv-moms pair) must reduce the
    // RC input, not be ignored: the debit balance is what ruta 48 receives.
    it('nets credits on the RC input accounts against their debits', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta21: 200000,
        ruta30: 50000,
        ruta48: 20000,
        ruta49: 30000,
      }
      const totals = new Map([['2645', { debit: 50000, credit: 30000 }]])
      const finding = runVatDeclarationChecks(rutor, totals)
        .find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')
      expect(finding?.status).toBe('WARNING')
      expect(finding?.message).toMatch(/30\s000 kr saknas/)
    })
  })

  // FK009 detection: if our calculator and SKV's recomputed sum disagree
  // we flag locally so we never submit a drift.
  it('flags ERROR when ruta49 drifts from the canonical formula', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta10: 100,
      ruta48: 20,
      ruta49: 99, // wrong: should be 80
    }
    const findings = runVatDeclarationChecks(rutor)
    const drift = findings.find((f) => f.code === 'SUMMA_MOMS_DRIFT')
    expect(drift?.status).toBe('ERROR')
  })

  it('ignores fractional-öre drift (≤ 0.5 SEK)', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta10: 100.30,
      ruta48: 20.10,
      ruta49: 80.20, // canonical formula exactly, only fractional öre
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'SUMMA_MOMS_DRIFT')).toBeUndefined()
  })

  // SKV §4.1.1.4 rule 1: taxable sales base without output VAT.
  it('flags ERROR when taxable sales (ruta 05) booked without output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 10000,
      // ruta 10/11/12 all zero: SKV rule 1 violation
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    const finding = findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')
    expect(finding?.status).toBe('ERROR')
    expect(finding?.message).toMatch(/försäljning/)
    expect(finding?.message).toMatch(/utgående moms/)
  })

  it('flags ERROR for ruta 06 (uttag) without output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta06: 5000,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')?.status).toBe('ERROR')
  })

  it('does not flag taxable sales without output VAT when output VAT is present', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 10000,
      ruta10: 2500,
      ruta49: 2500,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')).toBeUndefined()
    expect(findings.find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')).toBeUndefined()
  })

  // Regression (2026-07-27): the binary sales check cleared as soon as ANY
  // output VAT existed, so 2 000 kr of missing utgående moms on a 400 000 kr
  // base rendered "Inga fel hittades" with Skicka enabled. The proportional
  // form warns (never blocks: periodisering legitimately drifts this way).
  describe('SALES_OUTPUT_VAT_SHORTFALL (proportional, warning tier)', () => {
    it('warns when the sales base implies more output VAT than declared', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 400000,
        ruta10: 98000, // 100 000 kr expected at 25%: 2 000 kr moms missing
        ruta49: 98000,
      }
      const findings = runVatDeclarationChecks(rutor)
      const finding = findings.find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')
      expect(finding?.status).toBe('WARNING')
      expect(finding?.message).toMatch(/saknar/)
      expect(finding?.message).toMatch(/periodisering/)
      // Never a filing blocker: no ERROR may fire on this declaration, so
      // isFilingBlocked (ERROR-only) keeps Skicka enabled while the banner
      // stops claiming "Inga fel hittades".
      expect(findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')).toBeUndefined()
      expect(findings.every((f) => f.status === 'WARNING')).toBe(true)
    })

    it('stays green for an exact mixed-rate declaration', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 170000, // 100 000 @25% + 50 000 @12% + 20 000 @6%
        ruta10: 25000,
        ruta11: 6000,
        ruta12: 1200,
        ruta49: 32200,
      }
      expect(runVatDeclarationChecks(rutor)).toEqual([])
    })

    it('absorbs drift inside the 0.5% tolerance', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 100040, // implied base 100 000, tolerance 500
        ruta10: 25000,
        ruta49: 25000,
      }
      expect(
        runVatDeclarationChecks(rutor).find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL'),
      ).toBeUndefined()
    })

    it('warns just outside the 0.5% tolerance', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 100600, // implied base 100 000, tolerance 500
        ruta10: 25000,
        ruta49: 25000,
      }
      expect(
        runVatDeclarationChecks(rutor).find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')?.status,
      ).toBe('WARNING')
    })

    it('applies the 1 kr tolerance floor at a small base', () => {
      const inside: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 100.8, // implied 100, floor tolerance 1 kr
        ruta10: 25,
        ruta49: 25,
      }
      expect(
        runVatDeclarationChecks(inside).find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL'),
      ).toBeUndefined()

      const outside: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 104,
        ruta10: 25,
        ruta49: 25,
      }
      expect(
        runVatDeclarationChecks(outside).find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')?.status,
      ).toBe('WARNING')
    })

    it('does not fire when output VAT is absent entirely (binary ERROR owns that case)', () => {
      const rutor: VatDeclarationRutor = {
        ...emptyRutor,
        ruta05: 10000,
        ruta49: 0,
      }
      const findings = runVatDeclarationChecks(rutor)
      expect(findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')?.status).toBe('ERROR')
      expect(findings.find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')).toBeUndefined()
    })
  })

  // Mirror: output VAT without taxable sales base.
  it('flags ERROR when output VAT booked without taxable sales base', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      // No ruta 05/06/07/08
      ruta10: 2500,
      ruta49: 2500,
    }
    const findings = runVatDeclarationChecks(rutor)
    const finding = findings.find((f) => f.code === 'OUTPUT_VAT_WITHOUT_SALES_BASE')
    expect(finding?.status).toBe('ERROR')
    expect(finding?.message).toContain('momspliktiga intäktskonton')
    expect(finding?.message).toContain('Standard moms')
    expect(finding?.message).not.toContain('3001/3002/3003')
  })

  // SKV §4.1.1.4 rule 5: import base without import output VAT.
  it('flags ERROR when import base (ruta 50) without import output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 10000,
      // ruta 60/61/62 all zero
      ruta48: 0,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')?.status).toBe('ERROR')
  })

  // SKV §4.1.1.4 rule 6: import output VAT without import base.
  it('flags ERROR when import output VAT (ruta 60) without ruta 50', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta60: 2500,
      ruta48: 2500,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')?.status).toBe('ERROR')
  })

  it('does not flag import checks when both base and output VAT are present', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 10000,
      ruta60: 2500,
      ruta48: 2500,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')).toBeUndefined()
    expect(findings.find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')).toBeUndefined()
  })

  it('does not flag import checks for a mixed-rate import declaration', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 170000, // 100 000 @ 25% + 50 000 @ 12% + 20 000 @ 6%
      ruta60: 25000,
      ruta61: 6000,
      ruta62: 1200,
      ruta48: 32200,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')).toBeUndefined()
    expect(findings.find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')).toBeUndefined()
  })

  // The binary presence test passed this: SOME import output VAT existed, so
  // 100 000 kr of tullvärdesunderlag went out without its 25 000 kr importmoms.
  it('flags ERROR when only part of the import base carries output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 500000, // declared base
      ruta60: 100000, // only accounts for 400 000 kr of it
      ruta48: 100000,
      ruta49: 0,
    }
    const finding = runVatDeclarationChecks(rutor)
      .find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')
    expect(finding?.status).toBe('ERROR')
    expect(finding?.message).toMatch(/saknar utgående moms/)
  })

  // Mirror shape, also passed by the old binary test: ruta 50 was non-zero.
  it('flags ERROR when the import base is only partially reported', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 400000,
      ruta60: 125000, // implies a 500 000 kr base: 100 000 kr missing
      ruta48: 125000,
      ruta49: 0,
    }
    const finding = runVatDeclarationChecks(rutor)
      .find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')
    expect(finding?.status).toBe('ERROR')
    expect(finding?.message).toMatch(/saknas/)
  })

  // Tolerance boundary: max(1, 0.5% of the implied base) = 2 500 kr at 500 000.
  it('does not flag import base inside the per-voucher rounding tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 497501, // 2 499 kr short of the implied 500 000
      ruta60: 125000,
      ruta48: 125000,
      ruta49: 0,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')).toBeUndefined()
    expect(findings.find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')).toBeUndefined()
  })

  it('flags ERROR just outside the import tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 497000, // 3 000 kr short: beyond the 2 500 kr tolerance
      ruta60: 125000,
      ruta48: 125000,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(rutor).find((f) => f.code === 'IMPORT_OUTPUT_WITHOUT_BASE')?.status,
    ).toBe('ERROR')
  })

  it('does not flag an import base excess inside the tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 502499, // 2 499 kr above the implied 500 000
      ruta60: 125000,
      ruta48: 125000,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(rutor).find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT'),
    ).toBeUndefined()
  })

  it('flags ERROR just outside the import base excess tolerance', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 503000, // 3 000 kr above the implied 500 000: beyond the 2 500 kr tolerance
      ruta60: 125000,
      ruta48: 125000,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(rutor).find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')?.status,
    ).toBe('ERROR')
  })

  // At a small import base the tolerance is the 1 kr floor, not 0.5% (which
  // would be 0.50 kr on a 100 kr base). Every other import case above has a
  // basis large enough that the percentage branch wins, so the floor branch of
  // Math.max would otherwise go untested.
  it('applies the 1 kr tolerance floor at a small import base', () => {
    const withinFloor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta50: 100.5, // 0.50 kr over the implied 100 kr: inside the 1 kr floor
      ruta60: 25,
      ruta48: 25,
      ruta49: 0,
    }
    expect(
      runVatDeclarationChecks(withinFloor).find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT'),
    ).toBeUndefined()

    const outsideFloor: VatDeclarationRutor = { ...withinFloor, ruta50: 102 }
    expect(
      runVatDeclarationChecks(outsideFloor).find((f) => f.code === 'IMPORT_BASE_WITHOUT_OUTPUT')
        ?.status,
    ).toBe('ERROR')
  })

  // The sales pair stays binary on purpose: rutor 07/08 have no source accounts
  // in ACCOUNT_RUTA while their output VAT (2613/2616 etc.) still feeds ruta 10,
  // and periodiserade invoice lines credit 29xx with the moms left on 2611. A
  // proportional check would block filing on correct declarations.
  it('does not flag the sales pair when output VAT exceeds what ruta 05-08 implies', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 100000,
      ruta10: 125000, // e.g. VMB (2616) or frivillig uthyrning (2613) on top
      ruta48: 0,
      ruta49: 125000,
    }
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.find((f) => f.code === 'TAXABLE_SALES_WITHOUT_OUTPUT')).toBeUndefined()
    expect(findings.find((f) => f.code === 'OUTPUT_VAT_WITHOUT_SALES_BASE')).toBeUndefined()
    // The proportional warning checks the OPPOSITE direction only: excess
    // output (VMB, uthyrning, overrides) must never trigger it either.
    expect(findings.find((f) => f.code === 'SALES_OUTPUT_VAT_SHORTFALL')).toBeUndefined()
  })

  // Multiple findings should surface together so the user sees the whole picture.
  it('reports multiple distinct findings for a deeply broken declaration', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 10000,    // taxable sales but no output VAT
      ruta30: 2500,     // RC output but no RC basis
      ruta50: 5000,     // import base but no import output
      ruta48: 0,
      ruta49: 2500,
    }
    const findings = runVatDeclarationChecks(rutor)
    const codes = findings.map((f) => f.code).sort()
    expect(codes).toContain('TAXABLE_SALES_WITHOUT_OUTPUT')
    expect(codes).toContain('RC_BASIS_MISSING')
    expect(codes).toContain('IMPORT_BASE_WITHOUT_OUTPUT')
  })
})
