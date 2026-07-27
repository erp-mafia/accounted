import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * Should the Hem page hint that the user may be signed in to the wrong
 * account? (#1231, the "Chillen" support case: BankID resolved to a stale
 * signup account while all real bookkeeping lived in a second
 * email+password account with the same org number.)
 *
 * True only when BOTH hold:
 * 1. Every company the caller can see has zero journal entries (their
 *    account is bookkeeping-empty), and
 * 2. a company with one of the same org numbers, in an account they are
 *    NOT a member of, has at least one journal entry.
 *
 * The common case (an account with any bookkeeping at all) exits after one
 * indexed existence probe. The cross-account probe runs on the service
 * client but the result reduces to one boolean: nothing about the other
 * account is revealed beyond "your bookkeeping may live elsewhere".
 * Fails soft to false: this is an advisory line, never worth an error.
 */
export async function shouldShowOtherAccountHint(supabase: SupabaseClient): Promise<boolean> {
  try {
    // RLS scopes both reads to the caller's memberships.
    const [{ data: ownCompanies, error: companiesError }, { data: ownEntries, error: entriesError }] =
      await Promise.all([
        supabase.from('companies').select('id, org_number').is('archived_at', null),
        supabase.from('journal_entries').select('id').limit(1),
      ])

    if (companiesError || entriesError) return false
    if (!ownCompanies || ownCompanies.length === 0) return false
    if ((ownEntries ?? []).length > 0) return false

    const ownIds = new Set(ownCompanies.map((c) => c.id))
    const orgNumbers = [
      ...new Set(ownCompanies.map((c) => c.org_number).filter((n): n is string => Boolean(n))),
    ]
    if (orgNumbers.length === 0) return false

    const service = createServiceClient()
    const { data: sameOrgCompanies, error: sameOrgError } = await service
      .from('companies')
      .select('id')
      .in('org_number', orgNumbers)
      .is('archived_at', null)

    if (sameOrgError) return false
    const otherIds = (sameOrgCompanies ?? []).map((c) => c.id).filter((id) => !ownIds.has(id))
    if (otherIds.length === 0) return false

    const { data: otherEntries, error: otherEntriesError } = await service
      .from('journal_entries')
      .select('id')
      .in('company_id', otherIds)
      .limit(1)

    if (otherEntriesError) return false
    return (otherEntries ?? []).length > 0
  } catch {
    // Service key unavailable (some self-hosted setups) or transient failure.
    return false
  }
}
