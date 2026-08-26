import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { NOTICE_PRIORITY, type Notice } from './types'
import {
  detectBackupFailing,
  detectBrokenBankConnections,
  detectExpiringBankConnections,
  detectOtherAccountHint,
  detectSkvDisconnected,
  detectSkvUnexplained,
} from './categories'

const log = createLogger('notices')

export interface GetCompanyNoticesOptions {
  /**
   * Run the stale-dismissal reap after the response instead of on the read
   * path (Hem passes Next's `after`). The reap is hygiene: awaiting it made
   * every Hem render wait for a delete nobody sees.
   */
  deferReap?: (task: () => Promise<void>) => void
  /** Caller's user id: Skatteverket connections and dismissals are per user. */
  userId: string
  now?: Date
}

/**
 * All active, non-dismissed notices for a company, in NOTICE_PRIORITY order.
 * Predicates run in one parallel burst and individually soft-fail to null
 * (see categories.ts), so this is safe to call from server components on
 * every render, mirroring getWorklistCounts.
 *
 * Dismissals are per (company, user, notice id); notice ids embed a state
 * discriminator, so a dismissal hides exactly the state the user saw and a
 * NEW failure surfaces again. A failed dismissal read degrades to showing
 * everything: over-showing a real problem beats silently hiding it.
 *
 * This read path also reaps stale dismissals: when a category is currently
 * healthy, the caller's stored dismissals for that category describe a state
 * that no longer exists and are deleted (best effort). See the reaping
 * contract on Notice.id in lib/notices/types.ts.
 */
export async function getCompanyNotices(
  supabase: SupabaseClient,
  companyId: string,
  { userId, now = new Date(), deferReap }: GetCompanyNoticesOptions,
): Promise<Notice[]> {
  const [candidates, dismissedIds] = await Promise.all([
    Promise.all([
      detectBrokenBankConnections(supabase, companyId),
      detectSkvDisconnected(supabase, userId, companyId, now),
      detectBackupFailing(supabase, companyId),
      detectExpiringBankConnections(supabase, companyId, now),
      detectSkvUnexplained(supabase, companyId),
      detectOtherAccountHint(supabase, companyId),
    ]),
    fetchDismissedIds(supabase, companyId, userId),
  ])

  const byCategory = new Map(
    candidates.filter((n): n is Notice => n !== null).map((n) => [n.category, n]),
  )

  // Stale = dismissed under a category (id prefix 'category:') that is
  // currently healthy. other_account_hint's exact id carries no ':' and is
  // deliberately never reaped: its condition either holds or stops holding.
  const staleIds = [...dismissedIds].filter((id) => {
    const category = NOTICE_PRIORITY.find((c) => id.startsWith(`${c}:`))
    return category !== undefined && !byCategory.has(category)
  })
  if (deferReap) deferReap(() => reapStaleDismissals(supabase, companyId, userId, staleIds))
  else await reapStaleDismissals(supabase, companyId, userId, staleIds)

  return NOTICE_PRIORITY.map((category) => byCategory.get(category)).filter(
    (n): n is Notice => n !== undefined && !dismissedIds.has(n.id),
  )
}

/**
 * Best-effort deletion of dismissals whose category has recovered (see the
 * reaping contract in lib/notices/types.ts): keeping them would hide the NEXT
 * failure for ids without a volatile discriminator (backup_failing). Failures
 * are swallowed: reaping is hygiene, never worth failing a read for, and an
 * un-reaped row is retried on the next read. A predicate that soft-failed to
 * null counts as healthy here; the worst case is one extra re-dismiss, which
 * errs on the same side as everything else in this module: over-showing.
 */
async function reapStaleDismissals(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  staleIds: string[],
): Promise<void> {
  if (staleIds.length === 0) return
  try {
    const { error } = await supabase
      .from('notice_dismissals')
      .delete()
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .in('notice_id', staleIds)
    if (error) {
      log.warn('stale notice dismissal reap failed', { companyId, reason: error.message })
    }
  } catch (err) {
    log.warn('stale notice dismissal reap failed', {
      companyId,
      reason: err instanceof Error ? err.message : undefined,
    })
  }
}

async function fetchDismissedIds(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('notice_dismissals')
      .select('notice_id')
      .eq('company_id', companyId)
      .eq('user_id', userId)
    if (error) {
      log.error('notice dismissal read failed', { companyId, reason: error.message })
      return new Set()
    }
    return new Set((data ?? []).map((r) => r.notice_id as string))
  } catch (err) {
    log.error('notice dismissal read failed', {
      companyId,
      reason: err instanceof Error ? err.message : undefined,
    })
    return new Set()
  }
}
