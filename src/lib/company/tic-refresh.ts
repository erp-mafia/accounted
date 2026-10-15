'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'
import {
  decideOrgNumberChange,
  validStoredOrgNumber,
  type OrgNumberRefusalCode,
} from '@/lib/company/org-number-rule'

export interface RefreshCompanyProfileResult {
  ok?: true
  snapshot?: Record<string, unknown> | null
  fetchedAt?: string
  // Error *codes*, translated by the caller (same pattern as company/actions.ts):
  //   unauthorized | org_number_invalid | org_number_locked |
  //   org_number_personnummer_required | org_number_legal_entity_required |
  //   persist_failed | not_found
  error?: string
}

const REFUSAL_ERRORS: Record<OrgNumberRefusalCode, string> = {
  SETTINGS_ORG_NUMBER_LOCKED: 'org_number_locked',
  SETTINGS_ORG_NUMBER_INVALID: 'org_number_invalid',
  SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED: 'org_number_personnummer_required',
  SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED: 'org_number_legal_entity_required',
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
 * The number obeys the settings rule (lib/company/org-number-rule.ts): a
 * company without a valid number fills it in here (both stored copies); a
 * company that has one fetches with that number and no other. This fetch used
 * to overwrite both copies with whatever was typed, a side door past the lock
 * on the settings form. We then clear `tic_snapshot_fetched_at` to force
 * `ensureTicSnapshot` past its 7-day cache and let it do the live profile
 * fetch + write. All writes are RLS-scoped to the caller's company.
 */
export async function refreshCompanyProfileAction(
  companyId: string,
  orgNumberRaw: string,
): Promise<RefreshCompanyProfileResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized' }

  // The same rule as the settings save. Malformed input is refused at the
  // boundary rather than stored where it would later break SIE/SRU exports.
  const [settingsRead, companyRead] = await Promise.all([
    supabase.from('company_settings').select('org_number, entity_type').eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('org_number, entity_type').eq('id', companyId).maybeSingle(),
  ])
  if (settingsRead.error || companyRead.error) return { error: 'persist_failed' }
  const settings = settingsRead.data as { org_number?: string | null; entity_type?: string | null } | null
  const company = companyRead.data as { org_number?: string | null; entity_type?: string | null } | null
  const change = decideOrgNumberChange({
    incoming: orgNumberRaw,
    storedSettings: settings?.org_number,
    storedCompany: company?.org_number,
    entityType: settings?.entity_type || company?.entity_type,
  })
  if (change.kind === 'refused') return { error: REFUSAL_ERRORS[change.code] }
  // Unchanged: the typed number is the stored one, which must itself be
  // valid to fetch with.
  const orgNumber = change.kind === 'fill' ? change.value : validStoredOrgNumber(orgNumberRaw)
  if (!orgNumber) return { error: 'org_number_invalid' }

  // Force staleness so ensureTicSnapshot re-fetches instead of returning the
  // poisoned cache. The TIC fetch reads the company row, so it gets the
  // number too unless it already holds a valid one (never replaced).
  // Two literal payloads (no spread), so the column guard checks both shapes.
  const keepStoredNumber = validStoredOrgNumber(company?.org_number) !== null
  const { error: updateError } = keepStoredNumber
    ? await supabase.from('companies').update({ tic_snapshot_fetched_at: null }).eq('id', companyId)
    : await supabase
        .from('companies')
        .update({ tic_snapshot_fetched_at: null, org_number: orgNumber })
        .eq('id', companyId)
  if (updateError) return { error: 'persist_failed' }

  // A fill-in goes to the settings copy too: it leads for the form and every
  // bank call, and its audit trigger records the change (who, when, old, new).
  if (change.kind === 'fill') {
    const { error: settingsWriteError } = await supabase
      .from('company_settings')
      .update({ org_number: change.value })
      .eq('company_id', companyId)
    if (settingsWriteError) return { error: 'persist_failed' }
  }

  const { snapshot, source } = await ensureTicSnapshot({
    supabase,
    companyId,
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
