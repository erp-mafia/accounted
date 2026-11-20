/**
 * POST /api/v1/companies/{companyId}/voucher-gap-explanations
 *
 * Document a gap in a verifikationsserie per BFL 5 kap 6-7 §§ (the
 * unbroken-löpnummer obligation): supplemented by BFNAR 2013:2 kap 8 §
 * for the systemdokumentation / behandlingshistorik aspect. Voucher
 * numbers are sequential within (fiscal_period_id, voucher_series); any
 * missing number must have a documented explanation. The gap can be a
 * single number (gap_start = gap_end) or a range.
 *
 * Used by:
 *   - Migration / import flows that need to claim numbers but can't fill them
 *   - Audit response when a number was burned by a failed commit attempt
 *   - Operational recovery after manual reconciliation
 *
 * Idempotent (mandatory Idempotency-Key). Insert is small: no dry-run helper.
 */

import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import {
  checkVoucherGapExplanation,
  saveVoucherGapExplanation,
  VoucherGapExplanationStrictSchema,
} from '@/lib/core/bookkeeping/voucher-gaps'

// The rules are the service's (lib/core/bookkeeping/voucher-gaps.ts), which
// every door shares; this body refuses unknown keys on top. It used to allow
// 2000 characters against the table's 500, so 501-2000 failed in the database.
const CreateVoucherGapExplanation = VoucherGapExplanationStrictSchema

const VoucherGapExplanationCreated = z.object({
  id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  voucher_series: z.string(),
  gap_start: z.number().int(),
  gap_end: z.number().int(),
  explanation: z.string(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'voucher-gap-explanations.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/voucher-gap-explanations',
  summary: 'Document a gap in the verifikationsserie (BFL 5 kap 6-7 §§).',
  description:
    'Records an explanation for one or more missing voucher numbers in a series. Required when a number is unaccounted for during audit. Statutory basis: BFL 5 kap 6-7 §§ (verifikationsnummer i löpande följd utan luckor); BFNAR 2013:2 kap 8 § governs the systemdokumentation that surfaces the gap. Idempotent. Dry-runnable.',
  useWhen:
    'You\'re responding to a voucher-gap audit finding and need to document the cause. Also used by migration flows that claim numbers without filling them.',
  doNotUseFor:
    'Falsifying a series: every gap MUST have a genuine explanation. The dashboard surfaces these for auditor review.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'gap_end must be >= gap_start; a single-number gap has gap_start = gap_end.',
    'voucher_series is a single uppercase letter (A-Z). explanation is 1-500 characters after trimming.',
    'An explanation is write-once: the same series + period + numeric range already explained returns 409 VOUCHER_GAP_ALREADY_EXPLAINED (dry run included). A fiscal_period_id outside the company returns 404.',
  ],
  example: {
    request: {
      fiscal_period_id: 'a8f1…',
      voucher_series: 'A',
      gap_start: 142,
      gap_end: 145,
      explanation:
        'Migration from previous bookkeeping system on 2026-05-12: series A148-onwards corresponds to the new Accounted numbering; numbers A142-A145 were assigned in the legacy system to manual paper vouchers archived offline (BFL 7 kap retention applies). Paper vouchers are stored in the company archive under reference 2026-PAPER-Q2.',
    },
    response: {
      data: { id: '0e9c…', voucher_series: 'A', gap_start: 142, gap_end: 145 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CreateVoucherGapExplanation },
  response: { success: dataEnvelope(VoucherGapExplanationCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'voucher-gap-explanations.create',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = CreateVoucherGapExplanation.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    // The service checks the year is the company's (404) and that the gap
    // has no explanation yet (409), and inserts; a dry run runs the same
    // checks and writes nothing.
    const result = ctx.dryRun
      ? await checkVoucherGapExplanation(ctx.supabase, ctx.companyId!, body)
      : await saveVoucherGapExplanation(ctx.supabase, ctx.companyId!, ctx.userId, body)
    if (!result.ok) {
      if (result.status === 500) ctx.log.error('voucher-gap-explanations save failed', { details: result.details })
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        ...(result.details ? { details: result.details } : {}),
      })
    }
    if ('preview' in result) return dryRunPreview(result.preview, { requestId: ctx.requestId, log: ctx.log })
    return created(result.data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
