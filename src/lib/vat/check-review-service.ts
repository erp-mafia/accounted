/**
 * Marking a momsdeklaration WARNING reviewed for a period, and taking the
 * review back (crm#1171). One set of rules for both doors: the dashboard route
 * /api/reports/vat-declaration/check-reviews (source 'web') and the staged
 * MCP tool gnubok_mark_vat_check_reviewed (source 'agent', written when a
 * person approves it).
 *
 * The finding and its fingerprint are recomputed here from the books, never
 * taken from the caller: the server decides what is being reviewed. A caller
 * that saw the finding may pass the fingerprint it saw (expectedFingerprint);
 * when the figures moved in between the review is refused instead of
 * accepting figures nobody looked at.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateVatDeclaration, resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { vatFilingVerdict } from '@/lib/reports/vat-close-check'
import { fetchKontantmetodCutoffVatFacts } from './kontantmetod-cutoff-vat-facts'
import type { VatCheckReviewMark } from '@/lib/reports/vat-declaration-checks'
import { isReviewableVatCheck, vatCheckFingerprint } from './check-reviews'
import { insertVatCheckReviewRow, listVatCheckReviews, type VatCheckReviewPeriod } from './check-review-store'
import type { VatPeriodType } from '@/types'

export type VatCheckReviewErrorCode =
  | 'VAT_CHECK_NOT_FOUND'
  | 'VAT_CHECK_NOT_REVIEWABLE'
  | 'VAT_CHECK_CHANGED'
  | 'VAT_CHECK_REVIEW_NOT_FOUND'

export interface VatCheckReviewTarget {
  periodType: VatPeriodType
  /** Calendar year; for yearly, the year the räkenskapsår ends (or pass fiscalPeriodId). */
  year: number
  period: number
  /** Yearly only: the räkenskapsår the web view names the period by. */
  fiscalPeriodId?: string
  checkCode: string
}

export interface VatCheckReviewPreview {
  period: VatCheckReviewPeriod
  check_code: string
  message: string
  fingerprint: string
  /** The period's review of this finding while its figures are unchanged, or null. */
  current_review: VatCheckReviewMark | null
}

type Failure = { ok: false; code: VatCheckReviewErrorCode }

/** The finding as the books show it now, and whether it can be reviewed. */
export async function previewVatCheckReview(
  supabase: SupabaseClient,
  companyId: string,
  target: VatCheckReviewTarget,
): Promise<{ ok: true; preview: VatCheckReviewPreview } | Failure> {
  const declaration = await calculateVatDeclaration(
    supabase, companyId, target.periodType, target.year, target.period,
    { fiscalPeriodId: target.fiscalPeriodId },
  )
  // The same findings the reporters show, the kontantmetoden cut-off
  // WARNINGs included (#3440), so a person can review the one they saw.
  const kontantmetodCutoff = await fetchKontantmetodCutoffVatFacts(
    supabase, companyId, declaration.period.start, declaration.period.end,
  )
  const verdict = await vatFilingVerdict(supabase, companyId, declaration, {
    fiscalPeriodId: target.fiscalPeriodId,
    kontantmetodCutoff,
  })
  const inputs = { declaration, gaps: verdict.gaps }
  const findings = verdict.checks.filter((check) => check.code === target.checkCode)
  if (findings.length === 0) return { ok: false, code: 'VAT_CHECK_NOT_FOUND' }
  // One finding per code is the norm (the gap fold adds RC_BASIS_MISSING only
  // when the aggregate did not); with two, an ERROR among them decides.
  const check = findings.find((finding) => finding.status === 'ERROR') ?? findings[0]
  if (!isReviewableVatCheck(check, inputs)) return { ok: false, code: 'VAT_CHECK_NOT_REVIEWABLE' }
  const fingerprint = vatCheckFingerprint(check, inputs)
  const period: VatCheckReviewPeriod = {
    type: declaration.period.type,
    start: declaration.period.start,
    end: declaration.period.end,
  }
  const stored = (await listVatCheckReviews(supabase, companyId, period)).find(
    (review) => review.check_code === target.checkCode && review.fingerprint === fingerprint,
  )
  return {
    ok: true,
    preview: {
      period,
      check_code: target.checkCode,
      message: check.message,
      fingerprint,
      current_review: stored
        ? {
            reviewed_at: stored.reviewed_at,
            reviewed_by: stored.reviewed_by,
            reviewed_by_label: null,
            note: stored.note,
            source: stored.source,
          }
        : null,
    },
  }
}

export interface MarkVatCheckReviewedInput extends VatCheckReviewTarget {
  note?: string | null
  /** The fingerprint the caller saw; refused as VAT_CHECK_CHANGED when the books moved since. */
  expectedFingerprint?: string
  source: 'web' | 'agent'
}

export interface MarkedVatCheckReview extends VatCheckReviewMark {
  period: VatCheckReviewPeriod
  check_code: string
  fingerprint: string
  /** False when the same review (same figures, same note) was already in force: nothing was written. */
  changed: boolean
}

export async function markVatCheckReviewed(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: MarkVatCheckReviewedInput,
  options: { dryRun?: boolean } = {},
): Promise<
  | { ok: true; dryRun: true; preview: VatCheckReviewPreview }
  | { ok: true; dryRun?: false; data: MarkedVatCheckReview }
  | Failure
> {
  const outcome = await previewVatCheckReview(supabase, companyId, input)
  if (!outcome.ok) return outcome
  const { preview } = outcome
  if (input.expectedFingerprint && input.expectedFingerprint !== preview.fingerprint) {
    return { ok: false, code: 'VAT_CHECK_CHANGED' }
  }
  if (options.dryRun) return { ok: true, dryRun: true, preview }

  const note = input.note?.trim() ? input.note.trim() : null
  const current = preview.current_review
  if (current && current.note === note) {
    return {
      ok: true,
      data: { ...current, period: preview.period, check_code: preview.check_code, fingerprint: preview.fingerprint, changed: false },
    }
  }
  const row = await insertVatCheckReviewRow(supabase, {
    companyId,
    period: preview.period,
    checkCode: preview.check_code,
    action: 'reviewed',
    fingerprint: preview.fingerprint,
    note,
    source: input.source,
    actor: userId,
  })
  return {
    ok: true,
    data: {
      period: preview.period,
      check_code: preview.check_code,
      fingerprint: preview.fingerprint,
      reviewed_at: row.created_at,
      reviewed_by: userId,
      reviewed_by_label: null,
      note,
      source: input.source,
      changed: true,
    },
  }
}

/**
 * Take a review back: the warning nags again. Keyed by the period and code
 * only (no recompute), so a review whose figures have since changed can be
 * withdrawn too.
 */
export async function withdrawVatCheckReview(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  target: VatCheckReviewTarget & { source: 'web' | 'agent' },
): Promise<{ ok: true; data: { period: VatCheckReviewPeriod; check_code: string; withdrawn: true } } | Failure> {
  const dates = await resolvePeriodDates(
    supabase, companyId, target.periodType, target.year, target.period, target.fiscalPeriodId,
  )
  const period: VatCheckReviewPeriod = { type: target.periodType, start: dates.start, end: dates.end }
  const reviews = await listVatCheckReviews(supabase, companyId, period)
  if (!reviews.some((review) => review.check_code === target.checkCode)) {
    return { ok: false, code: 'VAT_CHECK_REVIEW_NOT_FOUND' }
  }
  await insertVatCheckReviewRow(supabase, {
    companyId,
    period,
    checkCode: target.checkCode,
    action: 'withdrawn',
    fingerprint: null,
    note: null,
    source: target.source,
    actor: userId,
  })
  return { ok: true, data: { period, check_code: target.checkCode, withdrawn: true } }
}
