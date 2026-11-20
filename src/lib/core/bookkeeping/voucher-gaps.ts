import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

/**
 * Voucher number gaps in a fiscal year (BFNAR 2013:2 p. 5.9: every series is
 * unbroken and checkable in the system; a gap needs a documented reason).
 *
 * One listing behind every door (the year-end readiness gate, the MCP
 * gnubok_list_voucher_gaps tool and attention resource, GET
 * /api/bookkeeping/voucher-gaps, the v1 compliance check). Each used to repeat
 * the detection with its own error handling, and two read a failure as "no
 * gaps": the MCP tool answered 0 gaps on a failed query, and the readiness
 * gate skipped a series whose detection failed, so year-end could run past an
 * unexplained gap after a transient error.
 */

export interface VoucherGapExplanationRow {
  id: string
  explanation: string
  user_id: string
  created_at: string
}

export interface ListedVoucherGap {
  series: string
  gap_start: number
  gap_end: number
  /** The documented reason, or null while the gap is unexplained. */
  explanation: VoucherGapExplanationRow | null
}

export interface VoucherGapListing {
  /** The series checked: the filter, else the year's voucher_sequences rows, else ['A']. */
  series: string[]
  /** The year's voucher_sequences series (empty with a filter or without rows). */
  sequenceSeries: string[]
  gaps: ListedVoucherGap[]
}

/** A gap read that did not complete: never to be read as "no gaps". */
export class VoucherGapCheckError extends Error {
  constructor(
    readonly stage: 'voucher_sequences' | 'detect_voucher_gaps' | 'voucher_gap_explanations',
    reason: string | undefined,
  ) {
    super(`Voucher gap check failed at ${stage}${reason ? `: ${reason}` : ''}`)
    this.name = 'VoucherGapCheckError'
  }
}

/**
 * Every gap in the year's series with its explanation. Series: the filter
 * when given, else the year's voucher_sequences rows, else ['A'] (a year
 * with vouchers but no sequence row is still checked). Throws
 * VoucherGapCheckError on any failed read, so a caller fails closed.
 */
export async function listVoucherGaps(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { series?: string } = {},
): Promise<VoucherGapListing> {
  let sequenceSeries: string[] = []
  if (!options.series) {
    const { data, error } = await supabase
      .from('voucher_sequences')
      .select('voucher_series')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
    if (error) throw new VoucherGapCheckError('voucher_sequences', error.message)
    sequenceSeries = ((data ?? []) as Array<{ voucher_series: string }>).map((r) => r.voucher_series)
  }
  const series = options.series ? [options.series] : sequenceSeries.length > 0 ? sequenceSeries : ['A']

  // The RPC checks one series per call and returns only (gap_start, gap_end).
  const gaps: ListedVoucherGap[] = []
  for (const s of series) {
    const { data, error } = await supabase.rpc('detect_voucher_gaps', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_series: s,
    })
    if (error) throw new VoucherGapCheckError('detect_voucher_gaps', error.message)
    for (const g of (data ?? []) as Array<{ gap_start: number; gap_end: number }>) {
      gaps.push({ series: s, gap_start: g.gap_start, gap_end: g.gap_end, explanation: null })
    }
  }

  if (gaps.length > 0) {
    // Keyed like the table's UNIQUE (company_id, fiscal_period_id,
    // voucher_series, gap_start, gap_end).
    const { data, error } = await supabase
      .from('voucher_gap_explanations')
      .select('id, voucher_series, gap_start, gap_end, explanation, user_id, created_at')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
    if (error) throw new VoucherGapCheckError('voucher_gap_explanations', error.message)
    const byKey = new Map(
      ((data ?? []) as Array<VoucherGapExplanationRow & { voucher_series: string; gap_start: number; gap_end: number }>).map(
        (e) => [`${e.voucher_series}:${e.gap_start}:${e.gap_end}`, e],
      ),
    )
    for (const gap of gaps) {
      const match = byKey.get(`${gap.series}:${gap.gap_start}:${gap.gap_end}`)
      if (match) {
        gap.explanation = {
          id: match.id,
          explanation: match.explanation,
          user_id: match.user_id,
          created_at: match.created_at,
        }
      }
    }
  }

  return { series, sequenceSeries, gaps }
}

// ---------------------------------------------------------------------------
// Explanations: one write, one rule set
// ---------------------------------------------------------------------------

const explanationFields = {
  fiscal_period_id: z.string().uuid(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'voucher_series must be a single uppercase letter A-Z'),
  gap_start: z.number().int().positive(),
  gap_end: z.number().int().positive(),
  // The table's CHECK allows 1-500 characters; trimmed so a blank one is refused.
  explanation: z.string().trim().min(1).max(500),
}
const gapEndNotBeforeStart = {
  check: (d: { gap_start: number; gap_end: number }) => d.gap_end >= d.gap_start,
  params: { message: 'gap_end must be >= gap_start', path: ['gap_end'] },
}

/**
 * The rules every door applies to a gap explanation: series A-Z, positive
 * numbers, gap_end not before gap_start, text 1-500 characters after
 * trimming. Unknown keys are stripped; the v1 body uses the strict variant.
 */
export const VoucherGapExplanationSchema = z
  .object(explanationFields)
  .refine(gapEndNotBeforeStart.check, gapEndNotBeforeStart.params)

/** The v1 request body: the same rules, unknown keys refused. */
export const VoucherGapExplanationStrictSchema = z
  .object(explanationFields)
  .strict()
  .refine(gapEndNotBeforeStart.check, gapEndNotBeforeStart.params)

export type VoucherGapExplanationInput = z.infer<typeof VoucherGapExplanationSchema>

export interface SavedVoucherGapExplanation extends VoucherGapExplanationInput {
  id: string
  created_at: string
}

/**
 * A refused explanation. Registry code: VALIDATION_ERROR (400), NOT_FOUND
 * (404: the year is not the company's), VOUCHER_GAP_ALREADY_EXPLAINED (409),
 * FORBIDDEN (403: RLS refused the session client) or INTERNAL_ERROR (500).
 */
export interface VoucherGapExplanationRefusal {
  ok: false
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'VOUCHER_GAP_ALREADY_EXPLAINED' | 'FORBIDDEN' | 'INTERNAL_ERROR'
  status: 400 | 403 | 404 | 409 | 500
  details?: Record<string, unknown>
}

/** The rules and the year's ownership: everything but the write. */
async function validateExplanation(
  supabase: SupabaseClient,
  companyId: string,
  input: unknown,
): Promise<{ ok: true; body: VoucherGapExplanationInput } | VoucherGapExplanationRefusal> {
  const parsed = VoucherGapExplanationSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      status: 400,
      details: {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    }
  }
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', parsed.data.fiscal_period_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', status: 500, details: { step: 'fiscal_period', reason: error.message } }
  if (!period) {
    return { ok: false, code: 'NOT_FOUND', status: 404, details: { resource: 'fiscal_period', field: 'fiscal_period_id' } }
  }
  return { ok: true, body: parsed.data }
}

const gapOf = (b: VoucherGapExplanationInput) => ({
  voucher_series: b.voucher_series,
  gap_start: b.gap_start,
  gap_end: b.gap_end,
})

/**
 * Every check saveVoucherGapExplanation runs, an already explained gap
 * included, without writing: the v1 dry run and the MCP staging check.
 * Returns the input as it would be saved (explanation trimmed).
 */
export async function checkVoucherGapExplanation(
  supabase: SupabaseClient,
  companyId: string,
  input: unknown,
): Promise<{ ok: true; preview: VoucherGapExplanationInput } | VoucherGapExplanationRefusal> {
  const checked = await validateExplanation(supabase, companyId, input)
  if (!checked.ok) return checked
  const body = checked.body
  const { data: existing, error } = await supabase
    .from('voucher_gap_explanations')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', body.fiscal_period_id)
    .eq('voucher_series', body.voucher_series)
    .eq('gap_start', body.gap_start)
    .eq('gap_end', body.gap_end)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', status: 500, details: { step: 'existing', reason: error.message } }
  if (existing) return { ok: false, code: 'VOUCHER_GAP_ALREADY_EXPLAINED', status: 409, details: gapOf(body) }
  return { ok: true, preview: body }
}

/**
 * Document why a voucher number gap exists (BFNAR 2013:2). Insert only: an
 * explanation is write-once (DECISIONS 2026-10-01), so a second one for the
 * same gap is refused with 409 instead of overwriting the first without a
 * trace. The year must be the company's: a service-role caller (v1, MCP)
 * bypasses RLS, and the foreign key alone accepted another company's year.
 *
 * One write behind the v1 route, the app's POST /api/bookkeeping/voucher-gaps
 * and the MCP gnubok_explain_voucher_gap approval, which used to insert with
 * three different rule sets (v1 up to 2000 characters against the table's
 * 500, the app upserting, MCP checking nothing and answering raw 500s).
 */
export async function saveVoucherGapExplanation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: unknown,
): Promise<{ ok: true; data: SavedVoucherGapExplanation } | VoucherGapExplanationRefusal> {
  const checked = await validateExplanation(supabase, companyId, input)
  if (!checked.ok) return checked
  const body = checked.body

  const { data, error } = await supabase
    .from('voucher_gap_explanations')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: body.fiscal_period_id,
      voucher_series: body.voucher_series,
      gap_start: body.gap_start,
      gap_end: body.gap_end,
      explanation: body.explanation,
    })
    .select('id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation, created_at')
    .single()
  if (error) {
    if (error.code === '23505') return { ok: false, code: 'VOUCHER_GAP_ALREADY_EXPLAINED', status: 409, details: gapOf(body) }
    if (error.code === '42501') return { ok: false, code: 'FORBIDDEN', status: 403 }
    return { ok: false, code: 'INTERNAL_ERROR', status: 500, details: { step: 'insert', reason: error.message } }
  }
  return { ok: true, data: data as SavedVoucherGapExplanation }
}

/**
 * The explanation input from MCP arguments or staged params, for
 * saveVoucherGapExplanation. Hosts do not always enforce the tool's number
 * types, and the executor used to Number() the range, so a numeric string
 * still reads as its number; anything else is left for the schema to refuse.
 */
export function voucherGapExplanationFromParams(params: Record<string, unknown>): Record<string, unknown> {
  const asNumber = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v)
  return {
    fiscal_period_id: params.fiscal_period_id,
    voucher_series: params.voucher_series,
    gap_start: asNumber(params.gap_start),
    gap_end: asNumber(params.gap_end),
    explanation: params.explanation,
  }
}
