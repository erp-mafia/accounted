import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { NOTICE_PRIORITY, type Notice } from './types'
import {
  detectBackupFailing,
  detectBrokenBankConnections,
  detectExpiringBankConnections,
  detectOtherAccountHint,
  detectSkvDisconnected,
} from './categories'

const log = createLogger('notices')

export interface GetCompanyNoticesOptions {
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
 */
export async function getCompanyNotices(
  supabase: SupabaseClient,
  companyId: string,
  { userId, now = new Date() }: GetCompanyNoticesOptions,
): Promise<Notice[]> {
  const [candidates, dismissedIds] = await Promise.all([
    Promise.all([
      detectBrokenBankConnections(supabase, companyId),
      detectSkvDisconnected(supabase, userId, companyId, now),
      detectBackupFailing(supabase, companyId),
      detectExpiringBankConnections(supabase, companyId, now),
      detectOtherAccountHint(supabase, companyId),
    ]),
    fetchDismissedIds(supabase, companyId, userId),
  ])

  const byCategory = new Map(
    candidates.filter((n): n is Notice => n !== null).map((n) => [n.category, n]),
  )
  return NOTICE_PRIORITY.map((category) => byCategory.get(category)).filter(
    (n): n is Notice => n !== undefined && !dismissedIds.has(n.id),
  )
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
