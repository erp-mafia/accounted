import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeOrgNumber, orgNumberKey, sameOrgNumber, toRedovisare12 } from '@/lib/invariants/org-number'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { decideOrgNumberChange, type OrgNumberChange } from '@/lib/company/org-number-rule'

/**
 * Which stored copy of the company's organisationsnummer counts, as written.
 * The company keeps two: company_settings.org_number, the maintained value,
 * and companies.org_number, the onboarding snapshot and the duplicate-company
 * guard. The settings copy leads; the company copy stands in when the settings
 * hold nothing or something that does not read as a number. An empty string is
 * no number, whichever copy holds it. When neither reads as one, the value is
 * returned as it is, so a door can refuse it by name.
 *
 * As written because a 12-digit form is the exact answer for a filing, where
 * the 10-digit key would leave the owner's birth century to a guess. Take this
 * for a row already in hand; a door without one reads
 * {@link readCompanyOrgNumber} or {@link companyOrgNumber}.
 */
export function effectiveOrgNumber(
  settingsValue: string | null | undefined,
  companyValue: string | null | undefined,
): string | null {
  const settings = settingsValue?.trim() || null
  const company = companyValue?.trim() || null
  if (orgNumberKey(settings) !== null) return settings
  if (orgNumberKey(company) !== null) return company
  return settings ?? company
}

interface StoredIdentity {
  orgNumber: string | null
  entityType: unknown
}

type IdentityRow = { org_number?: string | null; entity_type?: unknown } | null

/**
 * The number and the legal form a filing carries, from the company_settings row
 * in hand. The company row is read only when that row does not decide them. A
 * failed read throws: not knowing is not "no number".
 */
export async function companyIdentityFrom(
  supabase: SupabaseClient,
  companyId: string,
  settings: IdentityRow,
): Promise<StoredIdentity> {
  if (orgNumberKey(settings?.org_number) !== null && settings?.entity_type) {
    return { orgNumber: effectiveOrgNumber(settings.org_number, null), entityType: settings.entity_type }
  }
  const { data, error } = await supabase
    .from('companies')
    .select('org_number, entity_type')
    .eq('id', companyId)
    .maybeSingle()
  if (error) throw error
  const company = data as IdentityRow
  return {
    orgNumber: effectiveOrgNumber(settings?.org_number, company?.org_number),
    entityType: settings?.entity_type || company?.entity_type,
  }
}

async function readSettingsIdentity(supabase: SupabaseClient, companyId: string): Promise<IdentityRow> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data as IdentityRow
}

/** {@link effectiveOrgNumber} read from the database. A failed read throws. */
export async function readCompanyOrgNumber(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const settings = await readSettingsIdentity(supabase, companyId)
  if (orgNumberKey(settings?.org_number) !== null) return effectiveOrgNumber(settings?.org_number, null)
  return (await companyIdentityFrom(supabase, companyId, settings)).orgNumber
}

/**
 * The company's organisationsnummer as Accounted Connect's contract carries
 * it (AIS party, payments party, POS: 10 digits, no separator), or null when
 * the company has none that reads as one.
 *
 * Every bank call (AIS consent and reads, payments, the bankgiro lookup) and
 * the POS connection read the number here, so a stored form the contract
 * would refuse never leaves the installation as a contract error.
 */
export async function companyOrgNumber(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  return orgNumberKey(await readCompanyOrgNumber(supabase, companyId))
}

/**
 * The company's 12-digit identity on a Skatteverket call, or null when it has
 * no number: {@link readCompanyOrgNumber} through the one conversion, under the
 * company's legal form.
 */
export async function companyRedovisare(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { orgNumber, entityType } = await companyIdentityFrom(supabase, companyId, await readSettingsIdentity(supabase, companyId))
  if (!orgNumber) return null
  return toRedovisare12(orgNumber, await resolveCompanyEntityType(supabase, companyId, entityType))
}

/** How the org number an outside source names relates to the company it is brought into. */
/**
 * The org part of a bank file's message id. The bank's duplicate check keys on
 * the id and a re-download has to stay the same message, so the id keeps what
 * every file so far has carried: the company row's digits as written, twelve of
 * them where the row holds twelve. A company with nothing on that row takes the
 * key. An id, not an identity: nothing reads it back.
 */
export function bankFileIdOrg(companyValue: string | null | undefined, key: string | null): string {
  return companyValue?.replace(/\D/g, '') || (key ?? '')
}

export interface SourceOrgNumberCheck {
  /** The source's number as written, or null when it names none. */
  fileOrgNumber: string | null
  /** The company's number as stored, or null when it has none. */
  companyOrgNumber: string | null
  /** True only when both are present and denote different numbers. */
  mismatch: boolean
}

/**
 * The one comparison every wrong-company check uses: the SIE doors (dashboard
 * preview, onboarding step, MCP preflight, the submit gate in submitSIEJob),
 * the skattekonto file and provider connect.
 *
 * Through sameOrgNumber, so 556677-8899, 5566778899 and the century form
 * 16556677-8899 (or 19... for an enskild firma's personnummer) are one number.
 * A side without a number is not evidence of anything: #ORGNR is optional in
 * SIE 4 and a company may lack one in both copies, so that source passes.
 */
export function compareSourceOrgNumber(
  fileOrg: string | null | undefined,
  companyOrg: string | null | undefined,
): SourceOrgNumberCheck {
  const fileOrgNumber = fileOrg?.trim() || null
  const companyOrgNumber = companyOrg?.trim() || null
  const mismatch = fileOrgNumber !== null && companyOrgNumber !== null && !sameOrgNumber(fileOrgNumber, companyOrgNumber)
  return { fileOrgNumber, companyOrgNumber, mismatch }
}

/** {@link compareSourceOrgNumber} against the company's number. */
export async function checkSourceOrgNumber(
  supabase: SupabaseClient,
  companyId: string,
  fileOrg: string | null | undefined,
): Promise<SourceOrgNumberCheck> {
  // Nothing to compare: skip the read.
  if (!fileOrg?.trim()) return compareSourceOrgNumber(null, null)
  return compareSourceOrgNumber(fileOrg, await readCompanyOrgNumber(supabase, companyId))
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
  if (settingsOnly.kind === 'unchanged' || normalizeOrgNumber(storedSettings) !== null) return settingsOnly

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
