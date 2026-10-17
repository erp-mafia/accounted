/**
 * After-the-fact review: the postings company grants let through since a
 * person last marked them reviewed, read by Att göra ("Bokfört enligt
 * regel") and the agent briefing, the same records for both.
 *
 * list_company_grant_postings (migration 20261017100400) is SECURITY
 * INVOKER: a session reads it under RLS, the briefing through the service
 * role with the company filter. Best-effort: a failed read, or a database
 * without the grant tables yet (deploy order), is nothing to review, never a
 * broken page or briefing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { GrantPosting, GrantReview } from './types'

const log = createLogger('grants')

/** At most this many postings are listed at once; the rest wait for the next review. */
export const MAX_REVIEW_POSTINGS = 20

const EMPTY: GrantReview = { postings: [], paused: false, has_active_grants: false }

/** Codes meaning "this database does not have the grant tables yet" (deploy order): nothing to review, nothing to log. */
const NOT_IN_DATABASE_CODES: ReadonlySet<string> = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function toPosting(row: Record<string, unknown>): GrantPosting {
  return {
    use_id: String(row.use_id),
    grant_id: String(row.grant_id),
    grant_version: num(row.grant_version),
    counterparty_label: String(row.counterparty_label ?? ''),
    account_number: String(row.account_number ?? ''),
    amount_limit_sek: num(row.amount_limit_sek),
    grant_accepted_at: String(row.grant_accepted_at ?? ''),
    grant_revoked_at: typeof row.grant_revoked_at === 'string' ? row.grant_revoked_at : null,
    pending_operation_id: typeof row.pending_operation_id === 'string' ? row.pending_operation_id : null,
    transaction_id: typeof row.transaction_id === 'string' ? row.transaction_id : null,
    journal_entry_id: typeof row.journal_entry_id === 'string' ? row.journal_entry_id : null,
    voucher: typeof row.voucher === 'string' ? row.voucher : null,
    entry_status: typeof row.entry_status === 'string' ? row.entry_status : null,
    entry_date: String(row.entry_date ?? ''),
    amount_sek: num(row.amount_sek),
    pattern_verified: typeof row.pattern_verified === 'boolean' ? row.pattern_verified : null,
    committed_at: typeof row.committed_at === 'string' ? row.committed_at : null,
    reviewed_at: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
  }
}

export async function loadGrantReview(
  supabase: SupabaseClient,
  companyId: string,
  opts: { limit?: number } = {},
): Promise<GrantReview> {
  try {
    // One probe first: a company that never had a grant (nearly all of them)
    // pays one indexed read and nothing else.
    const { data: probe, error: probeError } = await supabase
      .from('company_grants')
      .select('id')
      .eq('company_id', companyId)
      .limit(1)
    if (probeError) {
      if (probeError.code && NOT_IN_DATABASE_CODES.has(probeError.code)) return EMPTY
      log.warn('grant postings could not be read', { companyId, code: probeError.code, error: probeError.message })
      return EMPTY
    }
    if (!probe || probe.length === 0) return EMPTY
    const [postingsRes, settingsRes, activeRes] = await Promise.all([
      supabase.rpc('list_company_grant_postings', {
        p_company_id: companyId,
        p_only_unreviewed: true,
        p_limit: opts.limit ?? MAX_REVIEW_POSTINGS,
      }),
      supabase.from('company_grant_settings').select('paused').eq('company_id', companyId).maybeSingle(),
      supabase
        .from('company_grants')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('revoked_at', null),
    ])
    if (postingsRes.error || settingsRes.error || activeRes.error) {
      const error = postingsRes.error ?? settingsRes.error ?? activeRes.error
      log.warn('grant postings could not be read', { companyId, code: error?.code, error: error?.message })
      return EMPTY
    }
    return {
      postings: ((postingsRes.data ?? []) as Array<Record<string, unknown>>).map(toPosting),
      paused: (settingsRes.data as { paused?: boolean } | null)?.paused === true,
      has_active_grants: (activeRes.count ?? 0) > 0,
    }
  } catch (err) {
    log.warn('grant postings could not be read', { companyId, error: err instanceof Error ? err.message : String(err) })
    return EMPTY
  }
}
