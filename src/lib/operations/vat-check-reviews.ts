/**
 * Marking a momsdeklaration WARNING reviewed for a period, for agents
 * (crm#1171). The agent stages it after the user has confirmed the finding is
 * right as booked; a person approves it, and the review is written in that
 * person's name with source 'agent'. Thin wrapper over
 * lib/vat/check-review-service.ts, the service the dashboard route
 * /api/reports/vat-declaration/check-reviews runs too, so the rules are the
 * same on both doors: only a WARNING, never an ERROR, never a check that did
 * not run, and the review lapses when the finding's figures change.
 *
 * MCP only, like vat-filings: the web view has its own route, and taking a
 * review back is a person's act there.
 */
import { z } from 'zod'
import { MarkVatCheckReviewedSchema } from '@/lib/api/schemas'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import { markVatCheckReviewed } from '@/lib/vat/check-review-service'
import type { VatFilingPeriodType } from '@/lib/vat/filing-record'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

function stageLabel(input: Record<string, unknown>): string {
  return formatPeriodLabel(input.period_type as VatFilingPeriodType, Number(input.year), Number(input.period))
}

export const vatCheckReviewsMark = defineOperation({
  id: 'vat-check-reviews.mark',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Record that a person reviewed a momsdeklaration warning for a VAT period.',
    description:
      'Marks one WARNING of the momsdeklaration completeness checks (declaration_checks in gnubok_vat_close_check, completeness_checks in gnubok_vat_declaration_validate) as reviewed for the period, with an optional note. The finding is recomputed from the books and its figures fingerprinted: while they stay the same the warning is reported with its review and leaves the close check blockers; when they change it returns. Nothing in the books changes and nothing is sent to Skatteverket.',
    useWhen:
      'The user has looked at an advisory warning (reviewable: true) and confirms it is right as booked, e.g. RC_BASIS_MISSING whose basis is booked in a rättelseverifikat.',
    doNotUseFor:
      'An ERROR (fix the books; filing stays blocked) or a warning nobody has checked. Do not mark a warning reviewed on your own judgement.',
    pitfalls: [
      'Only findings with reviewable: true: an ERROR, a check that could not run, or RC_INPUT_VAT_MISMATCH with no input VAT at all answer VAT_CHECK_NOT_REVIEWABLE.',
      'A code the period does not show answers VAT_CHECK_NOT_FOUND.',
      'The figures moved between staging and approval: VAT_CHECK_CHANGED; check again and stage anew.',
      'Yearly: year is the year the räkenskapsår ends in and period is 1.',
    ],
    example: {
      request: {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        check_code: 'RC_BASIS_MISSING',
        note: 'Basbeloppet för de 13 verifikaten är bokat i A61.',
      },
      response: {
        data: {
          period: { type: 'yearly', start: '2025-10-19', end: '2026-09-30' },
          check_code: 'RC_BASIS_MISSING',
          fingerprint: 'v1:0123456789abcdef',
          reviewed_at: '2026-10-15T09:00:00Z',
          reviewed_by: '11111111-1111-4111-8111-111111111111',
          reviewed_by_label: null,
          note: 'Basbeloppet för de 13 verifikaten är bokat i A61.',
          source: 'agent',
          changed: true,
        },
        meta: META,
      },
    },
  },
  input: MarkVatCheckReviewedSchema,
  output: z.object({
    period: z.object({
      type: z.enum(['monthly', 'quarterly', 'yearly']),
      start: z.string().describe('First day of the VAT period.'),
      end: z.string().describe('Last day of the VAT period.'),
    }),
    check_code: z.string(),
    fingerprint: z.string().describe('The reviewed figures; the review applies while the finding still has this fingerprint.'),
    reviewed_at: z.string(),
    reviewed_by: z.string().uuid().describe('The person who approved the review.'),
    reviewed_by_label: z.string().nullable(),
    note: z.string().nullable(),
    source: z.enum(['web', 'agent']),
    changed: z.boolean().describe('False when the same review was already in force; nothing was written.'),
  }),
  errorCodes: ['VAT_CHECK_NOT_FOUND', 'VAT_CHECK_NOT_REVIEWABLE', 'VAT_CHECK_CHANGED'],
  mcp: {
    name: 'gnubok_mark_vat_check_reviewed',
    title: 'Mark VAT Warning Reviewed',
    description:
      'Stage marking a momsdeklaration WARNING (reviewable: true in gnubok_vat_close_check) reviewed for the period once the user confirms it. Never an ERROR; it returns when the figures change.',
    keywords: ['granskad', 'markera som granskad', 'momsvarning', 'varning granskad', 'RC_BASIS_MISSING', 'kvittera varning'],
    stage: {
      pendingType: 'mark_vat_check_reviewed',
      title: (input) => `Markera momsvarning ${String(input.check_code)} som granskad för ${stageLabel(input)}`,
      // The approver approves the figures the preview fingerprinted: a commit
      // after the books changed is refused instead of accepting unseen figures.
      pinParams: (input, preview) => ({
        ...input,
        expected_fingerprint: input.expected_fingerprint ?? preview.fingerprint,
      }),
      preview: (input, preview) => ({
        period_label: stageLabel(input),
        check_code: preview.check_code,
        finding: preview.message,
        note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null,
        already_reviewed: preview.current_review !== null && preview.current_review !== undefined,
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await markVatCheckReviewed(
      ctx.supabase,
      ctx.companyId,
      ctx.userId,
      {
        periodType: input.period_type,
        year: input.year,
        period: input.period,
        fiscalPeriodId: input.fiscal_period_id,
        checkCode: input.check_code,
        note: input.note ?? null,
        expectedFingerprint: input.expected_fingerprint,
        source: 'agent',
      },
      { dryRun },
    )
    if (!outcome.ok) return { ok: false, code: outcome.code }
    if (outcome.dryRun) return { ok: true, dryRun: true, preview: { ...outcome.preview } }
    return { ok: true, data: outcome.data, created: outcome.data.changed }
  },
})
