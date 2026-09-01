import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Ids per existence probe. They travel in the PostgREST query string as
 * `company_id=in.(uuid,uuid,...)`, so an unbounded list would eventually run
 * past the gateway's request-header ceiling and be rejected outright. 100
 * UUIDs is roughly 3.7 KB, comfortably inside it.
 */
const PROBE_CHUNK_SIZE = 100

/**
 * Does any of these companies have at least one journal entry?
 *
 * The company filter is what makes this an index probe: naming the ids lets
 * Postgres use idx_journal_entries_company_id. Stops at the first chunk that
 * finds a row. Throws on a query error, which the caller turns into "no hint".
 */
async function hasAnyJournalEntry(
  client: SupabaseClient,
  companyIds: string[],
): Promise<boolean> {
  for (let i = 0; i < companyIds.length; i += PROBE_CHUNK_SIZE) {
    const { data, error } = await client
      .from('journal_entries')
      .select('id')
      .in('company_id', companyIds.slice(i, i + PROBE_CHUNK_SIZE))
      .limit(1)

    if (error) throw new Error(error.message)
    if ((data ?? []).length > 0) return true
  }
  return false
}

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
 * company-scoped existence probe. The cross-account probe runs on the service
 * client but the result reduces to one boolean: nothing about the other
 * account is revealed beyond "your bookkeeping may live elsewhere".
 * Fails soft to false: this is an advisory line, never worth an error.
 */
export async function shouldShowOtherAccountHint(supabase: SupabaseClient): Promise<boolean> {
  try {
    // RLS scopes every read here to the caller's memberships. Company lists
    // are paginated with fetchAllRows (PostgREST caps at 1000 rows; a byrå
    // user can belong to many companies); it throws on error, which the outer
    // catch turns into false.
    const ownCompanies = await fetchAllRows<{ id: string; org_number: string | null }>(
      ({ from, to }) =>
        supabase
          .from('companies')
          .select('id, org_number')
          .is('archived_at', null)
          .order('id')
          .range(from, to),
    )

    if (ownCompanies.length === 0) return false

    // The probe needs the company list, so it runs after it rather than beside
    // it. Leaving company_id out and letting RLS do the scoping reads as the
    // cheaper form and is the opposite: under the `authenticated` role the RLS
    // qual becomes a filter on the scan, so Postgres reads all of
    // journal_entries (~900 ms measured on prod, 4.2 s worst observed) on the
    // blocking Hem render instead of using idx_journal_entries_company_id
    // (~2 ms). Naming the ids cannot change the answer: user_company_ids(),
    // which journal_entries RLS uses, excludes archived companies, and so does
    // the list above.
    const ownIds = ownCompanies.map((c) => c.id)
    if (await hasAnyJournalEntry(supabase, ownIds)) return false

    const orgNumbers = [
      ...new Set(ownCompanies.map((c) => c.org_number).filter((n): n is string => Boolean(n))),
    ]
    if (orgNumbers.length === 0) return false

    const service = createServiceClient()
    const sameOrgCompanies = await fetchAllRows<{ id: string }>(({ from, to }) =>
      service
        .from('companies')
        .select('id')
        .in('org_number', orgNumbers)
        .is('archived_at', null)
        .order('id')
        .range(from, to),
    )

    const ownIdSet = new Set(ownIds)
    const otherIds = sameOrgCompanies.map((c) => c.id).filter((id) => !ownIdSet.has(id))
    if (otherIds.length === 0) return false

    return await hasAnyJournalEntry(service, otherIds)
  } catch {
    // Service key unavailable (some self-hosted setups) or transient failure.
    return false
  }
}
