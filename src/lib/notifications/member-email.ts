/**
 * Recipient resolution for notification emails.
 *
 * Every outbound notification restricts its recipient to active members of
 * the company: a token owner, schedule owner, or configured contact who has
 * since been removed must never receive company mail (the bare existence of
 * some notifications is sensitive financial signal).
 *
 * The lookup is deliberately two queries. `company_members.user_id`
 * references auth.users, not public.profiles, so the PostgREST embed
 * `profiles!inner(email)` has no foreign-key relationship to traverse and
 * fails the whole query with a 400. That embed shipped in four notification
 * senders and silently killed all of them: the recipient resolved to null
 * and every mail was skipped as "no recipient". Adding the FK instead would
 * mean a migration on a core tenancy table for zero functional gain
 * (see DECISIONS.md 2026-08-25).
 *
 * The lookup is best-effort and never throws: a failed lookup logs and
 * resolves to "no recipient", because notification delivery must never fail
 * the sync/cron/reconciliation that triggered it. Logging alone is not the
 * safety net (the embed bug WAS logged by one caller and nobody read it):
 * callers verify delivery end to end after deploy.
 *
 * SERVICE-ROLE CLIENT REQUIRED. Under an RLS user client this lookup
 * silently degrades: company_members is readable company-wide, but the
 * profiles SELECT policy is own-row-only, so resolveMemberEmail(other user)
 * would always be null. Every current caller is a service-role cron path;
 * keep it that way or widen the profiles policy first.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('member-email')

/**
 * Resolve one user's email, only if they are still an active member of the
 * company. Returns null (never throws) when the user is not a member, has no
 * profile email, or a query fails.
 */
export async function resolveMemberEmail(
  supabase: SupabaseClient,
  companyId: string,
  userId: string
): Promise<string | null> {
  const { data: member, error: memberError } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (memberError) {
    log.warn('could not read company members for notification recipient', {
      companyId,
      userId,
      error: memberError.message,
    })
    return null
  }
  if (!member) return null

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle()
  if (profileError) {
    log.warn('could not read profile email for notification recipient', {
      companyId,
      userId,
      error: profileError.message,
    })
    return null
  }
  return (profile as { email?: string | null } | null)?.email ?? null
}
