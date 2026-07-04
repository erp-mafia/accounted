'use server'

import { cookies, headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'

export interface RefreshCompanyProfileResult {
  ok?: true
  snapshot?: Record<string, unknown> | null
  fetchedAt?: string
  // Error *codes*, translated by the caller (same pattern as company/actions.ts):
  //   unauthorized | org_number_invalid | persist_failed | not_found
  error?: string
}

/**
 * Fetch Bolagsuppgifter on demand from the settings → Företag panel.
 *
 * The panel normally shows the cached `companies.tic_snapshot`. This action
 * lets the user (re)fetch it live by submitting an org number / personnummer:
 * the path that recovers a company whose cached snapshot is missing or wrong
 * (e.g. an enskild firma whose 10-digit personnummer previously fuzzy-matched
 * the wrong entity; `searchCompanyByOrgNumber` now expands it to the 12-digit
 * form so Lens resolves it exactly).
 *
 * We persist the (normalized) number and clear `tic_snapshot_fetched_at` to
 * force `ensureTicSnapshot` past its 7-day cache, then let it do the live
 * /profile fetch + write. All writes are RLS-scoped to the caller's company.
 */
export async function refreshCompanyProfileAction(
  companyId: string,
  orgNumberRaw: string,
): Promise<RefreshCompanyProfileResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized' }

  // Refuse malformed input at the boundary rather than storing a value that
  // would later break SIE/SRU exports (same rule as createCompanyFromOnboarding).
  const cleaned = normalizeOrgNumber(orgNumberRaw)
  if (!cleaned) return { error: 'org_number_invalid' }

  // Persist the (possibly corrected) number and force staleness so
  // ensureTicSnapshot re-fetches instead of returning the poisoned cache.
  const { error: updateError } = await supabase
    .from('companies')
    .update({ org_number: cleaned, tic_snapshot_fetched_at: null })
    .eq('id', companyId)
  if (updateError) return { error: 'persist_failed' }

  // Keep the settings form (which reads company_settings.org_number) in sync,
  // best-effort; the TIC fetch reads companies.org_number, updated above.
  await supabase
    .from('company_settings')
    .update({ org_number: cleaned })
    .eq('company_id', companyId)

  // Self-fetch needs the caller's session cookie and the current origin so it
  // reaches this same instance (dev / preview / prod); see ensureTicSnapshot.
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')
  const hdrs = await headers()
  const host = hdrs.get('host')
  const proto = hdrs.get('x-forwarded-proto') ?? 'https'
  const origin = host ? `${proto}://${host}` : undefined

  const { snapshot, source } = await ensureTicSnapshot({
    supabase,
    companyId,
    cookieHeader,
    origin,
    // The user is watching a spinner; give the ~7-13 call Lens fan-out room to
    // finish (the 5s default aborted every fetch during the May quota incident).
    timeoutMs: 10_000,
  })

  // 'fetched' = a fresh live fetch was persisted. 'fallback' = TIC returned
  // nothing / errored: surface it and leave the existing snapshot untouched
  // rather than blanking a good panel on a transient outage.
  if (source !== 'fetched' || !snapshot) {
    return { error: 'not_found' }
  }

  revalidatePath('/settings')
  return { ok: true, snapshot, fetchedAt: new Date().toISOString() }
}
