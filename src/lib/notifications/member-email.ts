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
 * Both functions are best-effort and never throw: a failed lookup logs and
 * resolves to "no recipient", because notification delivery must never fail
 * the sync/cron/reconciliation that triggered it. Logging alone is not the
 * safety net (the embed bug WAS logged by one caller and nobody read it):
 * callers verify delivery end to end after deploy.
 *
 * SERVICE-ROLE CLIENT REQUIRED. Under an RLS user client these lookups
 * silently degrade: company_members is readable company-wide, but the
 * profiles SELECT policy is own-row-only, so resolveMemberEmails would
 * return at most the caller's own email and resolveMemberEmail(other user)
 * always null. Every current caller is a service-role cron path; keep it
 * that way or widen the profiles policy first.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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

/**
 * Resolve every active member's email for a company, as a map of
 * user_id → email. Used by senders that route to a configured contact
 * address but must verify it against the member allowlist (skattekonto
 * drift alert). Returns an empty map (never throws) on any query failure,
 * which callers treat as "no authorised recipient".
 */
export async function resolveMemberEmails(
  supabase: SupabaseClient,
  companyId: string
): Promise<Map<string, string>> {
  const emails = new Map<string, string>()

  // fetchAllRows with stable ordering: PostgREST silently caps unpaged
  // reads at 1000 rows, which would drop members from the allowlist.
  let members: Array<{ user_id: string | null }>
  try {
    members = await fetchAllRows(({ from, to }) =>
      supabase
        .from('company_members')
        .select('user_id')
        .eq('company_id', companyId)
        .order('user_id', { ascending: true })
        .range(from, to)
    )
  } catch (err) {
    log.warn('could not read company members for notification allowlist', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return emails
  }

  const userIds = members
    .map((m) => m.user_id)
    .filter((id): id is string => typeof id === 'string')
  if (userIds.length === 0) return emails

  let profiles: Array<{ id: string; email: string | null }>
  try {
    profiles = await fetchAllRows(({ from, to }) =>
      supabase
        .from('profiles')
        .select('id, email')
        .in('id', userIds)
        .order('id', { ascending: true })
        .range(from, to)
    )
  } catch (err) {
    log.warn('could not read member emails for notification allowlist', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return emails
  }

  for (const row of profiles) {
    if (row.email) emails.set(row.id, row.email)
  }
  return emails
}
