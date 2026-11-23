import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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

/**
 * A voucher number held by a cancelled (makulerad) verifikat: posted, then
 * voided (today only by cancel_orphaned_entry, for the orphan of a failed
 * workflow). detect_voucher_gaps counts the number as used, so it is no gap,
 * while every journal list and report leaves the verifikat out. Listed so
 * each number in the series can be accounted for (BFNAR 2013:2 p. 5.9).
 */
export interface ListedCancelledVoucher {
  /** The cancelled journal entry: header and lines are kept. */
  id: string
  series: string
  voucher_number: number
  entry_date: string
  description: string | null
  /** The note written for this number (the orphan cleanup writes one), or null. */
  explanation: VoucherGapExplanationRow | null
}

export interface VoucherGapListing {
  /** The series checked: the filter, else the year's voucher_sequences rows, else ['A']. */
  series: string[]
  /** The year's voucher_sequences series (empty with a filter or without rows). */
  sequenceSeries: string[]
  gaps: ListedVoucherGap[]
  /** The checked series' cancelled numbers; present only with options.withCancelled. */
  cancelled?: ListedCancelledVoucher[]
}

/** A gap read that did not complete: never to be read as "no gaps". */
export class VoucherGapCheckError extends Error {
  constructor(
    readonly stage: 'voucher_sequences' | 'detect_voucher_gaps' | 'voucher_gap_explanations' | 'cancelled_vouchers',
    reason: string | undefined,
  ) {
    super(`Voucher gap check failed at ${stage}${reason ? `: ${reason}` : ''}`)
    this.name = 'VoucherGapCheckError'
  }
}

/**
 * Every gap in the year's series with its explanation. Series: the filter
 * when given, else the year's voucher_sequences rows, else ['A'] (a year
 * with vouchers but no sequence row is still checked). With withCancelled,
 * also the numbers those series hold on a cancelled verifikat (the listing
 * views; the year-end gate needs only the gaps). Throws
 * VoucherGapCheckError on any failed read, so a caller fails closed.
 */
export async function listVoucherGaps(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { series?: string; withCancelled?: boolean } = {},
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

  // Read once, and only when a gap or a cancelled number asks for one. Keyed
  // like the table's UNIQUE (company_id, fiscal_period_id, voucher_series,
  // gap_start, gap_end); a cancelled number's note is the range [n, n].
  let explanationsByKey: Map<string, VoucherGapExplanationRow> | null = null
  const explanationFor = async (voucherSeries: string, start: number, end: number): Promise<VoucherGapExplanationRow | null> => {
    if (!explanationsByKey) {
      const { data, error } = await supabase
        .from('voucher_gap_explanations')
        .select('id, voucher_series, gap_start, gap_end, explanation, user_id, created_at')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
      if (error) throw new VoucherGapCheckError('voucher_gap_explanations', error.message)
      explanationsByKey = new Map(
        ((data ?? []) as Array<VoucherGapExplanationRow & { voucher_series: string; gap_start: number; gap_end: number }>).map(
          (e): [string, VoucherGapExplanationRow] => [
            `${e.voucher_series}:${e.gap_start}:${e.gap_end}`,
            { id: e.id, explanation: e.explanation, user_id: e.user_id, created_at: e.created_at },
          ],
        ),
      )
    }
    return explanationsByKey.get(`${voucherSeries}:${start}:${end}`) ?? null
  }

  for (const gap of gaps) {
    gap.explanation = await explanationFor(gap.series, gap.gap_start, gap.gap_end)
  }

  if (!options.withCancelled) return { series, sequenceSeries, gaps }

  // The numbers detect_voucher_gaps counts as used that no journal list
  // shows: a cancelled verifikat that drew one. A cancelled draft holds
  // voucher_number 0 and no number.
  type CancelledRow = { id: string; voucher_series: string; voucher_number: number; entry_date: string; description: string | null }
  let rows: CancelledRow[]
  try {
    rows = await fetchAllRows<CancelledRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number, entry_date, description')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'cancelled')
        .gt('voucher_number', 0)
        .in('voucher_series', series)
        .order('voucher_series')
        .order('voucher_number')
        .order('id')
        .range(from, to),
    )
  } catch (err) {
    throw new VoucherGapCheckError('cancelled_vouchers', err instanceof Error ? err.message : undefined)
  }
  const cancelled: ListedCancelledVoucher[] = []
  for (const row of rows) {
    cancelled.push({
      id: row.id,
      series: row.voucher_series,
      voucher_number: row.voucher_number,
      entry_date: row.entry_date,
      description: row.description ?? null,
      explanation: await explanationFor(row.voucher_series, row.voucher_number, row.voucher_number),
    })
  }

  return { series, sequenceSeries, gaps, cancelled }
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
