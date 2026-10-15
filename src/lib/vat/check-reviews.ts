/**
 * Reviewed VAT warnings (crm#1171): a person looked at a WARNING of the
 * momsdeklaration completeness checks for one period and accepted it as
 * booked. The review quiets that warning for that period (the banner, the
 * stegen counters, gnubok_vat_close_check's blockers) for as long as the
 * figures the finding was computed from stay the same.
 *
 * Pure and client-safe: the web view applies reviews in the browser over the
 * same declaration payload and gap list it already reads, and the server
 * computes the same fingerprint when it stores a review. Storage is
 * check-review-store.ts, the mark and withdraw rules check-review-service.ts.
 *
 * What a review can never do:
 *  - touch an ERROR. Errors gate "Skicka" (isFilingBlocked) and a review is
 *    never attached to one, so the filing gate cannot be talked out of a
 *    finding. ML 2023:200 wants both halves of a reverse-charge purchase in
 *    the declaration (swedish-vat reference 2.1: "BOTH sides must be
 *    reported; silent netting is prohibited"), and that is what the ERROR
 *    tier enforces.
 *  - quiet a check that did not run (RC_BASIS_MISSING while the per-verifikat
 *    scan is unavailable): there is nothing to have reviewed.
 *  - quiet RC_INPUT_VAT_MISMATCH when there is no deductible input VAT at all
 *    (selfAssessedVatWithoutAnyInputVat): the close check treats that one as
 *    a blocker.
 *  - outlive the figures: the fingerprint covers the rutor the finding names
 *    and the per-verifikat or per-account facts it was computed from, so a
 *    new verifikat, a correction or a changed amount brings the warning back.
 */
import { roundOre } from '@/lib/money'
import {
  selfAssessedVatWithoutAnyInputVat,
  type VatCheckReviewMark,
  type VatDeclarationCheck,
} from '@/lib/reports/vat-declaration-checks'
import type { VatDeclaration } from '@/types'

/** Bumped when the fingerprint's inputs change; an older review then simply no longer matches. */
export const VAT_CHECK_FINGERPRINT_VERSION = 'v1'

/** The fields of one per-verifikat gap the RC_BASIS_MISSING fingerprint reads (RcBasisGap). */
export interface VatCheckGapInput {
  entryId: string
  rcOutputAccount: string
  rcOutputAmount: number
  missingBasisAmount: number
}

/**
 * Everything a finding is computed from, as both doors hold it: the
 * declaration (or its JSON payload) and the per-verifikat gap list, null when
 * the scan has not answered or failed.
 */
export interface VatCheckReviewInputs {
  declaration: Pick<VatDeclaration, 'rutor'> &
    Partial<Pick<VatDeclaration, 'rcInputAccountTotals' | 'rcBasisByRate' | 'revenueAccountsWithoutRuta'>>
  gaps: ReadonlyArray<VatCheckGapInput> | null
}

/** One stored review, latest per check code (check-review-store.ts). */
export interface VatCheckReview extends VatCheckReviewMark {
  check_code: string
  fingerprint: string
}

/** Whether a person may mark this finding reviewed (see the module comment). */
export function isReviewableVatCheck(check: VatDeclarationCheck, inputs: VatCheckReviewInputs): boolean {
  if (check.status !== 'WARNING') return false
  if (check.code === 'RC_BASIS_MISSING' && inputs.gaps === null) return false
  if (check.code === 'RC_INPUT_VAT_MISMATCH' && selfAssessedVatWithoutAnyInputVat(inputs.declaration.rutor)) {
    return false
  }
  return true
}

const ore = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? roundOre(n) : 0
}

/** The finding's inputs as one canonical value: same figures, same string, on either door. */
function fingerprintPayload(check: VatDeclarationCheck, inputs: VatCheckReviewInputs): unknown[] {
  const { declaration } = inputs
  const rutor = declaration.rutor as unknown as Record<string, unknown>
  const named = [...(check.rutor ?? Object.keys(rutor))].sort()
  const payload: unknown[] = [
    VAT_CHECK_FINGERPRINT_VERSION,
    check.code,
    named.map((ruta) => [ruta, ore(rutor[ruta])]),
  ]
  if (check.code === 'RC_BASIS_MISSING') {
    const byRate = declaration.rcBasisByRate
    payload.push(byRate ? [ore(byRate.r25), ore(byRate.r12), ore(byRate.r6)] : null)
    payload.push(
      (inputs.gaps ?? [])
        .map((gap) => [gap.entryId, gap.rcOutputAccount, ore(gap.rcOutputAmount), ore(gap.missingBasisAmount)] as const)
        .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : 0)),
    )
  }
  if (check.code === 'RC_INPUT_VAT_MISMATCH') {
    const totals = declaration.rcInputAccountTotals ?? {}
    payload.push(
      Object.keys(totals)
        .sort()
        .map((account) => [account, ore(totals[account]?.debit), ore(totals[account]?.credit)]),
    )
  }
  if (check.code === 'REVENUE_ACCOUNT_WITHOUT_RUTA') {
    payload.push(
      (declaration.revenueAccountsWithoutRuta ?? [])
        .map((account) => [account.account_number, ore(account.amount)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    )
  }
  return payload
}

/**
 * 64-bit non-cryptographic string hash (cyrb53's mixing, both 32-bit halves
 * kept). Change detection only: a review that collided would quiet one
 * advisory warning of the reviewer's own company, nothing more.
 */
function hash64(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** `v1:<16 hex>`: the fingerprint a review stores and is compared against. */
export function vatCheckFingerprint(check: VatDeclarationCheck, inputs: VatCheckReviewInputs): string {
  return `${VAT_CHECK_FINGERPRINT_VERSION}:${hash64(JSON.stringify(fingerprintPayload(check, inputs)))}`
}

/**
 * Attach each stored review to its finding when the finding is reviewable
 * and its figures are still the reviewed ones. Everything else passes through
 * unchanged, so the filing gate reads the same ERRORs either way.
 */
export function applyVatCheckReviews(
  checks: VatDeclarationCheck[],
  reviews: ReadonlyArray<VatCheckReview>,
  inputs: VatCheckReviewInputs,
): VatDeclarationCheck[] {
  if (reviews.length === 0) return checks
  const byCode = new Map(reviews.map((review) => [review.check_code, review]))
  return checks.map((check) => {
    const review = byCode.get(check.code)
    if (!review || !isReviewableVatCheck(check, inputs)) return check
    if (review.fingerprint !== vatCheckFingerprint(check, inputs)) return check
    const mark: VatCheckReviewMark = {
      reviewed_at: review.reviewed_at,
      reviewed_by: review.reviewed_by,
      reviewed_by_label: review.reviewed_by_label ?? null,
      note: review.note,
      source: review.source,
    }
    return { ...check, review: mark }
  })
}

/** The findings that still ask for attention: every ERROR, and the WARNINGs nobody has reviewed. */
export function unreviewedVatChecks(checks: VatDeclarationCheck[]): VatDeclarationCheck[] {
  return checks.filter((check) => !check.review)
}
