import { describe, expect, it } from 'vitest'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { rcInputTotalsFromDeclaration } from '@/lib/reports/vat-declaration'
import { isFilingBlocked, withRcBasisGapFindings } from '@/lib/reports/vat-filing-gate'
import {
  applyVatCheckReviews,
  isReviewableVatCheck,
  unreviewedVatChecks,
  vatCheckFingerprint,
  type VatCheckGapInput,
  type VatCheckReview,
  type VatCheckReviewInputs,
} from '../check-reviews'
import type { VatDeclaration, VatDeclarationRutor } from '@/types'

const ZERO_RUTOR = Object.fromEntries(
  ['05', '06', '07', '08', '10', '11', '12', '20', '21', '22', '23', '24', '30', '31', '32', '35', '36', '37', '38', '39', '40', '41', '42', '48', '49', '50', '60', '61', '62'].map(
    (n) => [`ruta${n}`, 0],
  ),
) as unknown as VatDeclarationRutor

type Declaration = Pick<VatDeclaration, 'period' | 'rutor' | 'rcInputAccountTotals' | 'rcBasisByRate' | 'revenueAccountsWithoutRuta'>

/**
 * The crm#1171 shape in small: three purchases carry fiktiv moms on 2614 with
 * no basis of their own (their fiktiv moms came in through a Fortnox rättelse),
 * and one collective rättelseverifikat books the basis for all three on 4531.
 * The period matches per momssats, so the per-verifikat gaps are advisory.
 */
function declaration(overrides: Partial<VatDeclarationRutor> = {}, rcInput = 300, basis25 = 1200): Declaration {
  return {
    period: { type: 'yearly', year: 2026, period: 1, start: '2025-10-19', end: '2026-09-30' },
    rutor: { ...ZERO_RUTOR, ruta22: basis25, ruta30: 300, ruta48: rcInput, ruta49: 300 - rcInput, ...overrides },
    rcInputAccountTotals: { '2645': { debit: rcInput, credit: 0 } },
    rcBasisByRate: { r25: basis25, r12: 0, r6: 0 },
    revenueAccountsWithoutRuta: [],
  }
}

const GAPS: VatCheckGapInput[] = [
  { entryId: 'je-a9', rcOutputAccount: '2614', rcOutputAmount: 100, missingBasisAmount: 400 },
  { entryId: 'je-a10', rcOutputAccount: '2614', rcOutputAmount: 150, missingBasisAmount: 600 },
  { entryId: 'je-a54', rcOutputAccount: '2614', rcOutputAmount: 50, missingBasisAmount: 200 },
]

/** The web view's composition: the shared checks folded with the scan. */
function checksFor(decl: Declaration, gaps: VatCheckGapInput[] | null) {
  return withRcBasisGapFindings(
    runVatDeclarationChecks(decl.rutor, rcInputTotalsFromDeclaration(decl), {
      revenueAccountsWithoutRuta: decl.revenueAccountsWithoutRuta,
    }),
    gaps === null ? { status: 'unavailable' } : { status: 'scanned', gapCount: gaps.length },
    decl.rcBasisByRate ? { rutor: decl.rutor, rcBasisByRate: decl.rcBasisByRate } : undefined,
  )
}

const inputsFor = (decl: Declaration, gaps: VatCheckGapInput[] | null): VatCheckReviewInputs => ({ declaration: decl, gaps })

function finding(decl: Declaration, gaps: VatCheckGapInput[] | null, code: string) {
  const found = checksFor(decl, gaps).find((check) => check.code === code)
  if (!found) throw new Error(`no ${code}`)
  return found
}

function reviewOf(code: string, fingerprint: string): VatCheckReview {
  return {
    check_code: code,
    fingerprint,
    reviewed_at: '2026-10-15T09:00:00Z',
    reviewed_by: 'user-1',
    reviewed_by_label: 'Fredrik',
    note: 'Basbeloppet är bokat i A61',
    source: 'web',
  }
}

describe('isReviewableVatCheck', () => {
  it('accepts the advisory RC_BASIS_MISSING once the scan has answered', () => {
    const decl = declaration()
    const check = finding(decl, GAPS, 'RC_BASIS_MISSING')
    expect(check.status).toBe('WARNING')
    expect(isReviewableVatCheck(check, inputsFor(decl, GAPS))).toBe(true)
  })

  it('refuses the scan-unavailable RC_BASIS_MISSING: nothing ran, nothing to review', () => {
    const decl = declaration()
    const check = finding(decl, null, 'RC_BASIS_MISSING')
    expect(check.status).toBe('WARNING')
    expect(isReviewableVatCheck(check, inputsFor(decl, null))).toBe(false)
  })

  it('refuses every ERROR', () => {
    // No basis anywhere: the FK004 shape, blocking.
    const decl = declaration({ ruta22: 0 }, 300, 0)
    const check = finding(decl, GAPS, 'RC_BASIS_MISSING')
    expect(check.status).toBe('ERROR')
    expect(isReviewableVatCheck(check, inputsFor(decl, GAPS))).toBe(false)
  })

  it('accepts a partial input VAT shortfall, refuses one with no input VAT at all', () => {
    const partial = declaration({}, 100)
    expect(isReviewableVatCheck(finding(partial, [], 'RC_INPUT_VAT_MISMATCH'), inputsFor(partial, []))).toBe(true)
    const none = declaration({}, 0)
    expect(isReviewableVatCheck(finding(none, [], 'RC_INPUT_VAT_MISMATCH'), inputsFor(none, []))).toBe(false)
  })
})

describe('vatCheckFingerprint', () => {
  const decl = declaration()
  const check = finding(decl, GAPS, 'RC_BASIS_MISSING')
  const base = vatCheckFingerprint(check, inputsFor(decl, GAPS))

  it('is versioned, stable, and the same over the JSON payload the web view reads', () => {
    expect(base).toMatch(/^v1:[0-9a-f]{16}$/)
    expect(vatCheckFingerprint(check, inputsFor(declaration(), [...GAPS]))).toBe(base)
    const overHttp = JSON.parse(JSON.stringify(decl)) as Declaration
    const gapsOverHttp = JSON.parse(JSON.stringify(GAPS)) as VatCheckGapInput[]
    expect(vatCheckFingerprint(JSON.parse(JSON.stringify(check)), inputsFor(overHttp, gapsOverHttp))).toBe(base)
  })

  it('does not depend on the order the scan lists the verifikat in', () => {
    expect(vatCheckFingerprint(check, inputsFor(decl, [...GAPS].reverse()))).toBe(base)
  })

  it('changes with a new gap, a changed amount or a changed basis box', () => {
    const more = [...GAPS, { entryId: 'je-a60', rcOutputAccount: '2614', rcOutputAmount: 25, missingBasisAmount: 100 }]
    expect(vatCheckFingerprint(check, inputsFor(decl, more))).not.toBe(base)
    const moved = GAPS.map((gap, i) => (i === 0 ? { ...gap, rcOutputAmount: 101 } : gap))
    expect(vatCheckFingerprint(check, inputsFor(decl, moved))).not.toBe(base)
    expect(vatCheckFingerprint(check, inputsFor(declaration({ ruta22: 1100, ruta21: 100 }), GAPS))).not.toBe(base)
    expect(vatCheckFingerprint(check, inputsFor({ ...decl, rcBasisByRate: { r25: 1200.5, r12: 0, r6: 0 } }, GAPS))).not.toBe(base)
  })

  it('ignores a ruta the finding is not computed from', () => {
    expect(vatCheckFingerprint(check, inputsFor(declaration({ ruta05: 50000, ruta10: 12500 }), GAPS))).toBe(base)
  })

  it('reads the 2645/2647 totals for an input VAT shortfall', () => {
    const partial = declaration({}, 100)
    const mismatch = finding(partial, [], 'RC_INPUT_VAT_MISMATCH')
    const before = vatCheckFingerprint(mismatch, inputsFor(partial, []))
    const after = vatCheckFingerprint(mismatch, inputsFor({ ...partial, rcInputAccountTotals: { '2645': { debit: 120, credit: 0 } } }, []))
    expect(after).not.toBe(before)
  })
})

describe('applyVatCheckReviews', () => {
  it('quiets the reviewed advisory for the period and keeps every other finding as it was', () => {
    const decl = declaration({}, 100)
    const checks = checksFor(decl, GAPS)
    const inputs = inputsFor(decl, GAPS)
    const rc = checks.find((check) => check.code === 'RC_BASIS_MISSING')!
    const reviewed = applyVatCheckReviews(checks, [reviewOf('RC_BASIS_MISSING', vatCheckFingerprint(rc, inputs))], inputs)

    expect(reviewed.find((check) => check.code === 'RC_BASIS_MISSING')?.review).toEqual({
      reviewed_at: '2026-10-15T09:00:00Z',
      reviewed_by: 'user-1',
      reviewed_by_label: 'Fredrik',
      note: 'Basbeloppet är bokat i A61',
      source: 'web',
    })
    expect(reviewed.find((check) => check.code === 'RC_INPUT_VAT_MISMATCH')?.review).toBeUndefined()
    expect(unreviewedVatChecks(reviewed).map((check) => check.code)).toEqual(['RC_INPUT_VAT_MISMATCH'])
    expect(isFilingBlocked(reviewed)).toBe(isFilingBlocked(checks))
  })

  it('lapses when the figures change: a new purchase without basis brings the warning back', () => {
    const decl = declaration()
    const inputs = inputsFor(decl, GAPS)
    const review = reviewOf('RC_BASIS_MISSING', vatCheckFingerprint(finding(decl, GAPS, 'RC_BASIS_MISSING'), inputs))
    const later = declaration({ ruta22: 1300, ruta30: 325, ruta48: 325 }, 325, 1300)
    const laterGaps = [...GAPS, { entryId: 'je-a62', rcOutputAccount: '2614', rcOutputAmount: 25, missingBasisAmount: 100 }]
    const checks = applyVatCheckReviews(checksFor(later, laterGaps), [review], inputsFor(later, laterGaps))
    const rc = checks.find((check) => check.code === 'RC_BASIS_MISSING')!
    expect(rc.status).toBe('WARNING')
    expect(rc.review).toBeUndefined()
  })

  it('never attaches to an ERROR, even with a review stored for the same code', () => {
    const decl = declaration()
    const inputs = inputsFor(decl, GAPS)
    const review = reviewOf('RC_BASIS_MISSING', vatCheckFingerprint(finding(decl, GAPS, 'RC_BASIS_MISSING'), inputs))
    // The collective rättelse is reversed: the basis is gone, the gaps block.
    const broken = declaration({ ruta22: 0 }, 300, 0)
    const checks = applyVatCheckReviews(checksFor(broken, GAPS), [review], inputsFor(broken, GAPS))
    expect(checks.every((check) => check.review === undefined)).toBe(true)
    expect(isFilingBlocked(checks)).toBe(true)
  })

  it('passes the list through untouched without reviews', () => {
    const decl = declaration()
    const checks = checksFor(decl, GAPS)
    expect(applyVatCheckReviews(checks, [], inputsFor(decl, GAPS))).toBe(checks)
  })
})
