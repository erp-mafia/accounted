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
 * Users whose login address is still unproven: a BankID signup that is
 * signed in before its typed address was confirmed (bankid_identities row
 * with email_verified_at NULL; BankID instant login, 2026-09-05). Company
 * mail must not go there: the address may belong to a stranger, and the
 * only mail an unproven address should ever receive is the one that proves
 * it. Best-effort like everything here: a failed lookup excludes nobody, so
 * a transient error costs at most one mail to an unproven address rather
 * than every notification of the company.
 */
export async function unverifiedAddressUserIds(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Set<string>> {
  const unverified = new Set<string>()
  if (userIds.length === 0) return unverified
  try {
    const { data, error } = await supabase
      .from('bankid_identities')
      .select('user_id')
      .in('user_id', userIds)
      .is('email_verified_at', null)
    if (error) {
      log.warn('could not read pending bankid identities for notification recipients', {
        error: error.message,
      })
      return unverified
    }
    for (const row of (data ?? []) as Array<{ user_id: string | null }>) {
      if (row.user_id) unverified.add(row.user_id)
    }
  } catch (err) {
    log.warn('could not read pending bankid identities for notification recipients', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return unverified
}

/**
 * Resolve one user's email, only if they are still an active member of the
 * company. Returns null (never throws) when the user is not a member, has no
 * profile email, an unproven login address, or a query fails.
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

  if ((await unverifiedAddressUserIds(supabase, [userId])).has(userId)) return null

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

  const unverified = await unverifiedAddressUserIds(supabase, userIds)
  for (const row of profiles) {
    if (row.email && !unverified.has(row.id)) emails.set(row.id, row.email)
  }
  return emails
}
