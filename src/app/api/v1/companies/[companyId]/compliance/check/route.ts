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
import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'

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

  // `detect_voucher_gaps` checks ONE series per call (p_series defaults to
  // 'A'), so the series have to be enumerated first: a company booking into
  // B / F / ... would otherwise be told "no gaps" while a real break sits in
  // another series. Same source and same ['A'] fallback as
  // `validateYearEndReadiness` and GET /api/bookkeeping/voucher-gaps.
  const { data: seriesRows, error: seriesError } = await supabase
    .from('voucher_sequences')
    .select('voucher_series')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
  if (seriesError) throw seriesError

  const seriesToCheck =
    seriesRows && seriesRows.length > 0
      ? (seriesRows as Array<{ voucher_series: string }>).map((r) => r.voucher_series)
      : ['A']

  // The RPC returns ONLY (gap_start, gap_end). The series is what we passed
  // in; whether the gap is documented comes from voucher_gap_explanations
  // below. Never read those off the RPC row.
  const gaps: Array<{ voucher_series: string; gap_start: number; gap_end: number }> = []
  for (const series of seriesToCheck) {
    const { data, error } = await supabase.rpc('detect_voucher_gaps', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_series: series,
    })
    // A failed detection must surface: silently dropping a series would
    // report "clean" for books whose continuity was never checked.
    if (error) throw error
    for (const g of (data ?? []) as Array<{ gap_start: number; gap_end: number }>) {
      gaps.push({ voucher_series: series, gap_start: g.gap_start, gap_end: g.gap_end })
    }
  }

  // Explanations are keyed exactly like the table's UNIQUE constraint
  // (company_id, fiscal_period_id, voucher_series, gap_start, gap_end).
  // A failed lookup throws rather than defaulting gaps to "explained".
  const explainedKeys = new Set<string>()
  if (gaps.length > 0) {
    const { data: explanations, error: explError } = await supabase
      .from('voucher_gap_explanations')
      .select('voucher_series, gap_start, gap_end')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
    if (explError) throw explError
    for (const e of (explanations ?? []) as Array<{
      voucher_series: string
      gap_start: number
      gap_end: number
    }>) {
      explainedKeys.add(`${e.voucher_series}:${e.gap_start}:${e.gap_end}`)
    }
  }

  const findings: FindingShape[] = gaps.map((g) => {
    const hasExplanation = explainedKeys.has(`${g.voucher_series}:${g.gap_start}:${g.gap_end}`)
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
      details: { count: b.count, hint: b.hint, ...(b.check_code ? { check_code: b.check_code } : {}), ...(b.entries ? { entries: b.entries } : {}) },
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
    'vat_close: details carries the rutor (ruta49 = to pay, negative = refund), the payment block with the deadline, and the sanity ratios.',
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
