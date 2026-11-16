/**
 * GET /api/v1/companies/{companyId}/compliance/check?type=...
 *
 * Accounted's defensible edge: a single, structured pre-flight endpoint that
 * surfaces the same compliance checks the MCP / dashboard run, in a form
 * an agent can act on programmatically.
 *
 * Generalises the existing MCP tools (gnubok_vat_close_check,
 * gnubok_year_end_readiness) under a single response shape. vat_close runs
 * the same computeVatCloseCheck the MCP tool runs (lib/reports/
 * vat-close-check.ts). New check types are a case in the switch below: the
 * response envelope stays stable so agents only learn one shape.
 *
 * Response shape:
 *   {
 *     type, ready: boolean, findings: [{ severity, code, message, details }],
 *     summary: string, generated_at, params: { ... }
 *   }
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { listVoucherGaps } from '@/lib/core/bookkeeping/voucher-gaps'
import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'
import {
  RATE_BASE_CHANGE_MIN_PCT_OF_TOTAL,
  RATE_SHARE_SHIFT_MIN_POINTS,
  REVENUE_DROP_PCT,
  REVENUE_SPIKE_PCT,
  VAT_SANITY_FLOOR_KRONOR,
} from '@/lib/reports/vat-period-comparison'

// --------------------------------------------------------------------
// Response envelope: identical shape across check types so agents learn
// one structure.
// --------------------------------------------------------------------

const Finding = z.object({
  severity: z.enum(['info', 'warning', 'blocker']),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

const ComplianceCheckResponse = z.object({
  type: z.string(),
  ready: z.boolean(),
  findings: z.array(Finding),
  summary: z.string(),
  generated_at: z.string(),
  params: z.record(z.string(), z.unknown()),
})

type FindingShape = z.infer<typeof Finding>

interface CheckResult {
  ready: boolean
  findings: FindingShape[]
  summary: string
  /** Free-form extra payload merged into the response under `details` (e.g. the VAT rutor + payment block). */
  extra?: Record<string, unknown>
}

// --------------------------------------------------------------------
// Check runners. Each runner is responsible for its own param parsing.
// --------------------------------------------------------------------

const SUPPORTED_TYPES = [
  'year_end_readiness',
  'voucher_gaps',
  'vat_close',
] as const
type CheckType = (typeof SUPPORTED_TYPES)[number]

const CheckTypeSchema = z.enum(SUPPORTED_TYPES)

async function runYearEndReadinessCheck(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  url: URL,
): Promise<CheckResult | { error: string; details?: unknown }> {
  const fiscalPeriodId = url.searchParams.get('fiscal_period_id')
  if (!fiscalPeriodId || !z.string().uuid().safeParse(fiscalPeriodId).success) {
    return {
      error: 'year_end_readiness requires fiscal_period_id (UUID) query param.',
    }
  }

  // Defense-in-depth: confirm the period belongs to this company before
  // handing the id to the engine. The engine ALSO scopes by company_id,
  // but returning a clean structured "not found" here is a better UX than
  // letting the engine throw a Swedish error string.
  const periodCheck = await ownsFiscalPeriod(supabase, companyId, fiscalPeriodId)
  if (!periodCheck) {
    return { error: 'fiscal_period_id not found in this company.' }
  }

  const validation = await validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId)
  const findings: FindingShape[] = []

  for (const err of validation.errors ?? []) {
    findings.push({ severity: 'blocker', code: 'YEAR_END_BLOCKER', message: err })
  }
  for (const w of validation.warnings ?? []) {
    findings.push({ severity: 'warning', code: 'YEAR_END_WARNING', message: w })
  }
  if ((validation.draftCount ?? 0) > 0) {
    findings.push({
      severity: 'blocker',
      code: 'YEAR_END_DRAFTS_PRESENT',
      message: `${validation.draftCount} draft journal entries must be committed or cancelled before year-end.`,
      details: { draft_count: validation.draftCount },
    })
  }
  if ((validation.unexplainedGaps ?? []).length > 0) {
    findings.push({
      severity: 'blocker',
      code: 'YEAR_END_UNEXPLAINED_VOUCHER_GAPS',
      message: `${validation.unexplainedGaps.length} voucher-number gap(s) lack an explanation (BFNAR 2013:2 kap 8 §).`,
      details: { gaps: validation.unexplainedGaps },
    })
  }
  if (!validation.trialBalanceBalanced) {
    findings.push({
      severity: 'blocker',
      code: 'YEAR_END_TRIAL_BALANCE_UNBALANCED',
      message: 'Trial balance does not balance; close blockers before year-end.',
    })
  }

  return {
    ready: validation.ready,
    findings,
    summary: validation.ready
      ? 'Period is ready for year-end closing.'
      : `Period is NOT ready (${findings.filter((f) => f.severity === 'blocker').length} blocker(s)).`,
    extra: {
      draft_count: validation.draftCount,
      unexplained_gap_count: validation.unexplainedGaps?.length ?? 0,
      sequence_mismatch_count: validation.sequenceMismatches?.length ?? 0,
      trial_balance_balanced: validation.trialBalanceBalanced,
    },
  }
}

async function runVoucherGapsCheck(
  supabase: SupabaseClient,
  companyId: string,
  url: URL,
): Promise<CheckResult | { error: string; details?: unknown }> {
  const fiscalPeriodId = url.searchParams.get('fiscal_period_id')
  if (!fiscalPeriodId || !z.string().uuid().safeParse(fiscalPeriodId).success) {
    return { error: 'voucher_gaps requires fiscal_period_id (UUID) query param.' }
  }

  // Same ownership pre-check as year_end_readiness: the RPC scopes by
  // company_id but returning a clean error here is better UX.
  const periodCheck = await ownsFiscalPeriod(supabase, companyId, fiscalPeriodId)
  if (!periodCheck) {
    return { error: 'fiscal_period_id not found in this company.' }
  }

  // The listing every door shares (lib/core/bookkeeping/voucher-gaps.ts):
  // every series the year has a sequence for, else series A, and a failed
  // read throws rather than reporting "clean" for books whose continuity was
  // never checked or defaulting a gap to "explained".
  const listing = await listVoucherGaps(supabase, companyId, fiscalPeriodId)
  const seriesToCheck = listing.series
  const gaps = listing.gaps.map((g) => ({
    voucher_series: g.series,
    gap_start: g.gap_start,
    gap_end: g.gap_end,
    explained: g.explanation !== null,
  }))

  const findings: FindingShape[] = gaps.map((g) => {
    const hasExplanation = g.explained
    return {
      severity: hasExplanation ? 'info' : 'blocker',
      code: hasExplanation ? 'VOUCHER_GAP_EXPLAINED' : 'VOUCHER_GAP_UNEXPLAINED',
      message: `Series ${g.voucher_series}: gap ${g.gap_start}${g.gap_end > g.gap_start ? `-${g.gap_end}` : ''}${hasExplanation ? ' (explained)' : ' (no explanation)'}.`,
      details: {
        voucher_series: g.voucher_series,
        gap_start: g.gap_start,
        gap_end: g.gap_end,
        has_explanation: hasExplanation,
      },
    }
  })

  const unexplainedCount = findings.filter((f) => f.code === 'VOUCHER_GAP_UNEXPLAINED').length

  return {
    ready: unexplainedCount === 0,
    findings,
    summary:
      gaps.length === 0
        ? `Verifikationsserie ${seriesToCheck.join(', ')} is continuous (no gaps).`
        : `${unexplainedCount} unexplained gap(s) of ${gaps.length} total. Document via POST /voucher-gap-explanations.`,
    extra: {
      total_gaps: gaps.length,
      unexplained_count: unexplainedCount,
      series_checked: seriesToCheck,
    },
  }
}

/**
 * "Can I close VAT?" for one momsperiod: the MCP close check
 * (computeVatCloseCheck), in the shared envelope. ready is its
 * ready_to_close; each blocker and each completeness finding becomes a
 * finding (a high blocker or an ERROR check is a blocker), and the rutor,
 * the payment and the sanity ratios ride along under details.
 */
async function runVatCloseCheck(
  supabase: SupabaseClient,
  companyId: string,
  url: URL,
): Promise<CheckResult | { error: string; details?: unknown }> {
  const args: Record<string, unknown> = { period_type: url.searchParams.get('period_type') ?? undefined }
  for (const key of ['year', 'period'] as const) {
    const raw = url.searchParams.get(key)
    if (raw !== null) args[key] = Number(raw)
  }
  let result: Awaited<ReturnType<typeof computeVatCloseCheck>>
  try {
    result = await computeVatCloseCheck(args, companyId, supabase)
  } catch (err) {
    // A malformed period is the caller's to fix; anything else is ours.
    if ((err as { code?: string }).code === 'VALIDATION_ERROR') return { error: (err as Error).message }
    throw err
  }

  const findings: FindingShape[] = [
    ...result.blockers.map((b) => ({
      severity: (b.severity === 'high' ? 'blocker' : b.severity === 'medium' ? 'warning' : 'info') as FindingShape['severity'],
      code: `VAT_CLOSE_${b.kind.toUpperCase()}`,
      message: b.message,
      details: {
        count: b.count,
        hint: b.hint,
        ...(b.check_code ? { check_code: b.check_code } : {}),
        ...(b.entries ? { entries: b.entries } : {}),
        // VAT_CLOSE_EARLIER_VAT_ON_SETTLEMENT_ACCOUNT: the day it describes and what it is made of.
        ...(b.settlement_accounts ? { as_of: b.as_of, settlement_accounts: b.settlement_accounts } : {}),
      },
    })),
    ...result.declaration_checks.map((c) => ({
      severity: (c.status === 'ERROR' ? 'blocker' : c.status === 'WARNING' ? 'warning' : 'info') as FindingShape['severity'],
      code: c.code,
      message: c.message,
      details: { rutor: c.rutor },
    })),
  ]

  return {
    ready: result.ready_to_close,
    findings,
    summary: result.summary,
    extra: {
      period: result.period,
      period_label: result.period_label,
      rutor: result.rutor,
      payment: result.payment,
      sanity: result.sanity,
    },
  }
}

// --------------------------------------------------------------------
// Endpoint definition
// --------------------------------------------------------------------

// Documents the parameters the handler and the check runners read. The
// handler parses them itself (type via CheckTypeSchema, fiscal_period_id per
// check type); this schema describes that contract for the registry.
const CheckQuery = z.object({
  type: CheckTypeSchema.describe('Which check to run.'),
  fiscal_period_id: z
    .string()
    .uuid()
    .optional()
    .describe('Fiscal period to check (id from GET /fiscal-periods). Required by year_end_readiness and voucher_gaps.'),
  period_type: z
    .enum(['monthly', 'quarterly', 'yearly'])
    .optional()
    .describe('vat_close: the momsperiod length.'),
  year: z.coerce.number().int().optional().describe('vat_close: the year; for yearly, the year the räkenskapsår ends.'),
  period: z.coerce.number().int().optional().describe('vat_close: 1-12 monthly, 1-4 quarterly, 1 yearly.'),
})

registerEndpoint({
  operation: 'compliance.check',
  method: 'GET',
  path: '/api/v1/companies/:companyId/compliance/check',
  summary: 'Run a structured compliance pre-flight check.',
  description:
    'Generalised pre-flight that consolidates the Accounted pre-close validators under one envelope. Supported check types: year_end_readiness (BFNAR 2017:3 + ÅRL 2:1 blockers), voucher_gaps (BFNAR 2013:2 kap 8 § series continuity), vat_close (can the momsperiod be closed: SKV 4700 rutor, bookkeeping blockers and the momsdeklaration completeness checks the web filing UI uses; the same answer as the MCP tool gnubok_vat_close_check). New types can be added without changing the response shape.',
  useWhen:
    'Before committing to an irreversible action (VAT close, year-end close), or as a periodic audit sweep to surface blockers before they become urgent.',
  doNotUseFor:
    'Executing the underlying action: this is read-only. After a passing check, call the corresponding async endpoint (POST /fiscal-periods/{id}/year-end, etc).',
  pitfalls: [
    'year_end_readiness and voucher_gaps require fiscal_period_id (UUID); vat_close requires period_type, year and period.',
    'voucher_gaps covers EVERY voucher series registered for the period (A, B, F, ...), not only series A.',
    'A passing check is a SNAPSHOT: the state can change between the check and the action. The same blocker logic runs again on commit.',
    'vat_close: details carries the rutor signed exactly as the momsdeklaration files them (ruta49 = to pay, negative = refund; a box whose credit notes exceed its sales is negative), the payment block with the deadline, and sanity, a comparison with the previous period of the same length.',
    `vat_close: details.sanity is advisory and never changes ready. ratios.rate_shares gives each rate's share (25/12/6, percent) of the taxable base derived from output VAT (ruta 10/11/12 divided by the rate), for the current and previous period, null when a period has no sales or a negative rate. anomalies: rate_share_shift (one per rate whose share moved at least ${RATE_SHARE_SHIFT_MIN_POINTS} percentage points while its base moved at least max(${VAT_SANITY_FLOOR_KRONOR} kr, ${RATE_BASE_CHANGE_MIN_PCT_OF_TOTAL} % of the larger total); delta_pct is in percentage points), revenue_drop and revenue_spike (ruta 05 down more than ${REVENUE_DROP_PCT} % or up more than ${REVENUE_SPIKE_PCT} %, skipped when both periods are below ${VAT_SANITY_FLOOR_KRONOR} kr). ratios.output_vat_ratio_25/12/6 are deprecated: read rate_shares.`,
  ],
  example: {
    response: {
      data: {
        type: 'year_end_readiness',
        ready: false,
        findings: [
          { severity: 'blocker', code: 'YEAR_END_DRAFTS_PRESENT', message: '3 draft journal entries must be committed or cancelled before year-end.', details: { draft_count: 3 } },
        ],
        summary: 'Period is NOT ready (1 blocker(s)).',
        generated_at: '2026-05-12T14:00:00Z',
        params: { fiscal_period_id: 'a8f1…' },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'compliance:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: CheckQuery },
  response: { success: dataEnvelope(ComplianceCheckResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'compliance.check',
  async (request, ctx) => {
    const url = new URL(request.url)
    const typeRaw = url.searchParams.get('type')
    const typeParse = CheckTypeSchema.safeParse(typeRaw)
    if (!typeParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'type',
          message: `type must be one of: ${SUPPORTED_TYPES.join(', ')}.`,
          supported_types: SUPPORTED_TYPES,
        },
      })
    }
    const type: CheckType = typeParse.data

    try {
      let result: CheckResult | { error: string; details?: unknown }
      const params: Record<string, unknown> = { type }

      switch (type) {
        case 'year_end_readiness':
          result = await runYearEndReadinessCheck(ctx.supabase, ctx.companyId!, ctx.userId, url)
          params.fiscal_period_id = url.searchParams.get('fiscal_period_id')
          break
        case 'voucher_gaps':
          result = await runVoucherGapsCheck(ctx.supabase, ctx.companyId!, url)
          params.fiscal_period_id = url.searchParams.get('fiscal_period_id')
          break
        case 'vat_close':
          result = await runVatCloseCheck(ctx.supabase, ctx.companyId!, url)
          params.period_type = url.searchParams.get('period_type')
          params.year = url.searchParams.get('year')
          params.period = url.searchParams.get('period')
          break
      }

      if ('error' in result) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { message: result.error, ...(result.details ? { issues: result.details } : {}) },
        })
      }

      return ok(
        {
          type,
          ready: result.ready,
          findings: result.findings,
          summary: result.summary,
          generated_at: new Date().toISOString(),
          params,
          ...(result.extra ? { details: result.extra } : {}),
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('compliance.check failed', err as Error, { type })
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)
