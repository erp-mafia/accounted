import type { SupabaseClient } from '@supabase/supabase-js'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { decideOrgNumberChange, validStoredOrgNumber, type OrgNumberChange } from '@/lib/company/org-number-rule'

/**
 * The company's organisationsnummer as Accounted Connect's contract carries
 * it (AIS party, payments party, POS: 10 digits, no separator), or null when
 * the company has none that reads as one.
 *
 * The stored value may be either form a person or a provider wrote: 10 digits,
 * or 12 with the century in front (16 for a legal entity; 18, 19 or 20 for an
 * enskild firma, whose organisationsnummer is the owner's personnummer and is
 * often stored with its century). Both read as the same 10 digits through
 * orgNumberKey (lib/invariants/org-number.ts), the one rule for that. The
 * settings row leads; the company row stands in when the settings hold none
 * or one that does not read as a number.
 *
 * Every bank call (AIS consent and reads, payments, the bankgiro lookup) and
 * the POS connection read the number here, so a stored form the contract
 * would refuse never leaves the installation as a contract error.
 */
export async function companyOrgNumber(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data: settings } = await supabase.from('company_settings').select('org_number').eq('company_id', companyId).maybeSingle()
  const fromSettings = orgNumberKey((settings as { org_number?: string | null } | null)?.org_number ?? null)
  if (fromSettings) return fromSettings
  const { data: company } = await supabase.from('companies').select('org_number').eq('id', companyId).maybeSingle()
  return orgNumberKey((company as { org_number?: string | null } | null)?.org_number ?? null)
}

/**
 * What writing `incoming` as the company's org number does, under the one
 * rule in lib/company/org-number-rule.ts, reading the stored copies it needs.
 * The company row is read only when the settings copy does not already decide
 * it (no change, or a valid number there). `settings` is the company_settings
 * row the caller already holds; its entity_type leads, the company row's
 * stands in for legacy rows without one. A failed read fails closed.
 */
export async function resolveOrgNumberChange(
  supabase: SupabaseClient,
  companyId: string,
  incoming: string | null | undefined,
  settings: { org_number?: unknown; entity_type?: unknown } | null,
): Promise<OrgNumberChange | { kind: 'error'; error: unknown }> {
  const storedSettings = typeof settings?.org_number === 'string' ? settings.org_number : null
  const settingsOnly = decideOrgNumberChange({ incoming, storedSettings, storedCompany: null, entityType: settings?.entity_type })
  if (settingsOnly.kind === 'unchanged' || validStoredOrgNumber(storedSettings) !== null) return settingsOnly

  const { data: company, error } = await supabase
    .from('companies')
    .select('org_number, entity_type')
    .eq('id', companyId)
    .maybeSingle()
  if (error) return { kind: 'error', error }
  const row = company as { org_number?: string | null; entity_type?: string | null } | null
  return decideOrgNumberChange({
    incoming,
    storedSettings,
    storedCompany: row?.org_number ?? null,
    entityType: settings?.entity_type || row?.entity_type,
  })
}
