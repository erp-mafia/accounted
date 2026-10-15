/**
 * Reads and writes of vat_check_reviews (migration 20261015180000): the
 * append-only record of who accepted which momsdeklaration WARNING for which
 * period. The rules (what is reviewable, the fingerprint) are
 * check-reviews.ts; marking and withdrawing are check-review-service.ts.
 *
 * Server-only: takes a Supabase client (cookie session for the dashboard
 * route, service role for the MCP door) and filters every query by
 * company_id, RLS or not.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatCheckReview } from './check-reviews'
import type { VatPeriodType } from '@/types'

/** A VAT period as the reviews key it: its own dates (a helårsmoms period is its räkenskapsår). */
export interface VatCheckReviewPeriod {
  type: VatPeriodType
  start: string
  end: string
}

interface ReviewRow {
  check_code: string
  action: 'reviewed' | 'withdrawn'
  fingerprint: string | null
  note: string | null
  source: 'web' | 'agent'
  actor: string
  created_at: string
}

/** Names for the people behind reviews; empty when the client may not read them (a session reads only its own profile). */
async function reviewerLabels(client: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return labels
  const { data, error } = await client.from('profiles').select('id, email, full_name').in('id', ids)
  if (error) return labels
  for (const row of (data ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>) {
    const label = row.full_name?.trim() || row.email?.trim()
    if (label) labels.set(row.id, label)
  }
  return labels
}

/**
 * The reviews in force for a period: per check code the latest row, kept
 * only when it is a review (a later withdrawal ends it). Whether a review
 * still matches the current figures is applyVatCheckReviews' call.
 */
export async function listVatCheckReviews(
  supabase: SupabaseClient,
  companyId: string,
  period: Pick<VatCheckReviewPeriod, 'start' | 'end'>,
  options: { labelClient?: SupabaseClient } = {},
): Promise<VatCheckReview[]> {
  const { data, error } = await supabase
    .from('vat_check_reviews')
    .select('check_code, action, fingerprint, note, source, actor, created_at')
    .eq('company_id', companyId)
    .eq('period_start', period.start)
    .eq('period_end', period.end)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  const latest = new Map<string, ReviewRow>()
  for (const row of (data ?? []) as ReviewRow[]) {
    if (!latest.has(row.check_code)) latest.set(row.check_code, row)
  }
  const reviewed = [...latest.values()].filter((row) => row.action === 'reviewed' && row.fingerprint)
  const labels = options.labelClient
    ? await reviewerLabels(options.labelClient, reviewed.map((row) => row.actor))
    : new Map<string, string>()
  return reviewed.map((row) => ({
    check_code: row.check_code,
    fingerprint: row.fingerprint as string,
    reviewed_at: row.created_at,
    reviewed_by: row.actor,
    reviewed_by_label: labels.get(row.actor) ?? null,
    note: row.note,
    source: row.source,
  }))
}

export interface VatCheckReviewRowInput {
  companyId: string
  period: VatCheckReviewPeriod
  checkCode: string
  action: 'reviewed' | 'withdrawn'
  fingerprint: string | null
  note: string | null
  source: 'web' | 'agent'
  actor: string
}

/** Append one row; answers its timestamp. */
export async function insertVatCheckReviewRow(
  supabase: SupabaseClient,
  input: VatCheckReviewRowInput,
): Promise<{ created_at: string }> {
  const { data, error } = await supabase
    .from('vat_check_reviews')
    .insert({
      company_id: input.companyId,
      period_type: input.period.type,
      period_start: input.period.start,
      period_end: input.period.end,
      check_code: input.checkCode,
      action: input.action,
      fingerprint: input.action === 'reviewed' ? input.fingerprint : null,
      note: input.note,
      source: input.source,
      actor: input.actor,
    })
    .select('created_at')
    .single()
  if (error) throw error
  return { created_at: (data as { created_at: string }).created_at }
}
