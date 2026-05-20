'use server'

import { headers, cookies } from 'next/headers'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setActiveCompany } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { mapEntityType } from '@/lib/company-lookup/entity-type-map'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

/**
 * Check whether an org number is already registered in any non-archived
 * gnubok company. Uses the service role because RLS hides rows the caller
 * isn't a member of — and "other users' duplicates" is exactly what we
 * need to detect. Returns null when `orgNumber` is empty/malformed. Throws
 * if the underlying query fails — callers must not silently treat that as
 * "no duplicate," or the whole guard gets bypassed on transient DB errors.
 */
async function findExistingCompanyByOrgNumber(
  orgNumber: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
  const cleaned = normalizeOrgNumber(orgNumber)
  if (!cleaned) return null

  const service = createServiceClient()
  const { data, error } = await service
    .from('companies')
    .select('id, name')
    .eq('org_number', cleaned)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Duplicate-org lookup failed: ${error.message}`)
  }

  return data ?? null
}

export async function switchCompany(companyId: string): Promise<{ error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Unauthorized' }
  }

  try {
    await setActiveCompany(supabase, user.id, companyId)
    // No revalidatePath — the client performs a hard navigation
    // (window.location.assign) after this action returns, which wipes
    // every React/router/fetch cache wholesale. revalidatePath would be a
    // no-op and would just race with the hard reload.
    return {}
  } catch {
    return { error: 'Du har inte tillgång till detta företag.' }
  }
}

/**
 * Create a company from onboarding wizard data.
 *
 * This runs on the server so that if the Next.js server is unavailable when
 * the user clicks the final "Fortsätt" button, the action never reaches
 * Supabase and no ghost company is created. All operations (company,
 * membership, chart of accounts, settings, fiscal period, active company)
 * happen sequentially; if any step after company creation fails the company
 * is rolled back to avoid partial state.
 */
export async function createCompanyFromOnboarding(params: {
  teamId: string
  settings: Record<string, unknown>
  fiscalPeriod: {
    startDate: string
    endDate: string
    name: string
  }
  // Optional TIC lookup result captured during the onboarding form. When
  // supplied, persisted to companies.tic_snapshot so downstream features
  // (specialized accountant agent composer, MCP briefing) can read the same
  // Bolagsverket-sourced data the form used. Empty for manual entry paths.
  ticLookup?: {
    companyName: string
    isCeased: boolean
    address: { street: string | null; postalCode: string | null; city: string | null } | null
    registration: { fTax: boolean; vat: boolean }
    bankAccounts: { type: string; accountNumber: string; bic: string | null }[]
    email: string | null
    phone: string | null
    sniCodes: { code: string; name: string }[]
  } | null
}): Promise<{ companyId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Unauthorized' }
  }

  const entityType = params.settings.entity_type as string | undefined
  if (entityType !== 'enskild_firma' && entityType !== 'aktiebolag') {
    return { error: 'Ogiltig företagsform.' }
  }

  const companyName = (params.settings.company_name as string | undefined) || 'Mitt företag'

  // Duplicate-org guard. We don't have a DB unique constraint on
  // companies.org_number (can't add one safely without cleaning up any
  // existing duplicates first), so enforce uniqueness at the application
  // boundary. Must run before the create RPC so we don't leave a ghost
  // company if the duplicate is detected mid-flow.
  //
  // normalizeOrgNumber returns null for malformed input — we refuse rather
  // than storing a value that would break SIE/SRU exports later.
  const rawOrgNumber = params.settings.org_number as string | undefined
  const cleanedOrgNumber = normalizeOrgNumber(rawOrgNumber)
  if (rawOrgNumber && rawOrgNumber.trim() && !cleanedOrgNumber) {
    return { error: 'org_number_invalid' }
  }
  if (cleanedOrgNumber) {
    try {
      const existing = await findExistingCompanyByOrgNumber(cleanedOrgNumber)
      if (existing) {
        return { error: 'org_number_exists' }
      }
    } catch (err) {
      // Guard must fail closed: if we can't confirm uniqueness, don't create
      // a company. A silent pass-through would let transient DB errors
      // through as duplicates (exactly the bug Greptile flagged).
      console.error('[createCompanyFromOnboarding] duplicate-org lookup failed', err)
      return { error: 'Kunde inte verifiera organisationsnummer. Försök igen.' }
    }
  }

  // 1. Create company + owner membership atomically via RPC
  const { data: newCompanyId, error: companyError } = await supabase.rpc('create_company_with_owner', {
    p_name: companyName,
    p_entity_type: entityType,
    p_team_id: params.teamId,
  })

  if (companyError || !newCompanyId) {
    console.error('[createCompanyFromOnboarding] company creation failed', companyError)
    return { error: 'Kunde inte skapa företag. Försök igen.' }
  }

  // Helper: roll back the company if a subsequent step fails. Deletes in FK order.
  const rollback = async (reason: string, err: unknown) => {
    console.error(`[createCompanyFromOnboarding] rolling back ${newCompanyId}: ${reason}`, err)
    await supabase.from('company_settings').delete().eq('company_id', newCompanyId)
    await supabase.from('fiscal_periods').delete().eq('company_id', newCompanyId)
    await supabase.from('chart_of_accounts').delete().eq('company_id', newCompanyId)
    await supabase.from('company_members').delete().eq('company_id', newCompanyId)
    await supabase.from('companies').delete().eq('id', newCompanyId)
  }

  // Mirror the normalized org_number onto the companies row so future
  // duplicate checks and cross-references are reliable. MUST be error-checked
  // and rolled back on failure — otherwise the freshly-created company would
  // exist without an org_number and the duplicate guard would never match it
  // for any future user (the very guard this code is enforcing).
  if (cleanedOrgNumber) {
    const { error: orgUpdateError } = await supabase
      .from('companies')
      .update({ org_number: cleanedOrgNumber })
      .eq('id', newCompanyId)
    if (orgUpdateError) {
      await rollback('org_number update failed', orgUpdateError)
      return { error: 'Kunde inte spara organisationsnummer. Försök igen.' }
    }
  }

  // Persist the FULL TIC profile (sniCodes + purpose + beneficial-owners +
  // financials + …) once at signup. We call ensureTicSnapshot which:
  //   1. Reads companies.tic_snapshot — empty for a brand-new row, so misses
  //   2. Falls back to company_settings.org_number → uses the cleaned one
  //   3. Self-fetches /api/extensions/ext/tic/profile with forwarded cookies
  //   4. Persists the full profile + fetched_at timestamp
  //
  // This avoids the double-fetch the agent build path would otherwise
  // trigger (lookup at form, then profile at agent build). On failure we
  // fall through silently — the company row is already created, the agent
  // build path will retry enrichment later, and we don't block signup.
  if (cleanedOrgNumber) {
    try {
      const hdrs = await headers()
      const cookieStore = await cookies()
      const host = hdrs.get('host')
      const proto =
        hdrs.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
      const origin = host
        ? `${proto}://${host}`
        : (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
      const cookieHeader = cookieStore
        .getAll()
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')

      await ensureTicSnapshot({
        supabase,
        companyId: newCompanyId,
        cookieHeader,
        origin,
      })
    } catch (err) {
      // Best-effort enrichment. Signup must not fail because TIC is slow,
      // unavailable, or the extension is disabled.
      console.warn('[createCompanyFromOnboarding] tic profile enrichment failed', err)
    }
  } else if (params.ticLookup) {
    // No org_number — we can't call /profile authoritatively, but the
    // wizard already had a lookup result. Persist it as a degraded snapshot
    // so the agent build at least sees what the user typed.
    const { error: ticErr } = await supabase
      .from('companies')
      .update({
        tic_snapshot: params.ticLookup,
        tic_snapshot_fetched_at: new Date().toISOString(),
      })
      .eq('id', newCompanyId)
    if (ticErr) {
      console.warn('[createCompanyFromOnboarding] tic snapshot persist failed', ticErr)
    }
  }

  // 2. Seed chart of accounts
  const { error: coaError } = await supabase.rpc('seed_chart_of_accounts', {
    p_company_id: newCompanyId,
    p_entity_type: entityType,
  })
  if (coaError) {
    await rollback('COA seeding failed', coaError)
    return { error: 'Kunde inte skapa kontoplan. Försök igen.' }
  }

  // 3. Save settings (strip UI-only and managed fields)
  const {
    id: _id,
    user_id: _uid,
    company_id: _cid,
    created_at: _ca,
    updated_at: _ua,
    is_first_fiscal_year: _ify,
    first_year_start: _fys,
    first_year_end: _fye,
    ...settingsToSave
  } = params.settings

  const { error: settingsError } = await supabase
    .from('company_settings')
    .upsert(
      {
        ...settingsToSave,
        company_id: newCompanyId,
        onboarding_complete: true,
        onboarding_step: 4,
      },
      { onConflict: 'company_id' },
    )

  if (settingsError) {
    await rollback('settings upsert failed', settingsError)
    return { error: 'Kunde inte spara inställningar. Försök igen.' }
  }

  // 4. Create fiscal period
  const { error: periodError } = await supabase.from('fiscal_periods').upsert(
    {
      company_id: newCompanyId,
      name: params.fiscalPeriod.name,
      period_start: params.fiscalPeriod.startDate,
      period_end: params.fiscalPeriod.endDate,
    },
    { onConflict: 'company_id,period_start,period_end' },
  )

  if (periodError) {
    await rollback('fiscal period upsert failed', periodError)
    return { error: 'Kunde inte skapa räkenskapsår. Försök igen.' }
  }

  // 5. Set as active company
  try {
    await setActiveCompany(supabase, user.id, newCompanyId)
  } catch (err) {
    // Non-fatal: the company was created successfully; the user can switch manually
    console.error('[createCompanyFromOnboarding] setActiveCompany failed', err)
  }

  revalidatePath('/')
  return { companyId: newCompanyId }
}

/**
 * One-click company setup from a TIC/Bolagsverket company role.
 *
 * The picker page at /select-company passes a `CompanyLookupResult` already
 * fetched from `/api/extensions/ext/tic/lookup`, plus the `EnrichmentCompanyRole`
 * minimums (org number, legal name, legal entity type). This action derives
 * sensible defaults (accrual, quarterly moms for VAT-registered, Jan-Dec
 * fiscal year) and delegates to `createCompanyFromOnboarding` so the
 * provisioning path is identical to the manual wizard. On success it clears
 * the enrichment row consumed by this path — the manual wizard leaves it
 * intact so a returning BankID user can still reach `/select-company` and
 * pick another directorship.
 *
 * Requires `lookup` to be non-null: if TIC `/lookup` is unreachable, the client
 * must route to the manual wizard instead. Silently defaulting `vat_registered`
 * to false for a momsregistrerat bolag would violate ML 17 kap (invoices
 * without moms), so we refuse to guess.
 */
export async function createCompanyFromTicRole(params: {
  teamId: string
  orgNumber: string
  legalName: string
  legalEntityType: string
  lookup: CompanyLookupResult | null
}): Promise<{ companyId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Unauthorized' }
  }

  const entityType = mapEntityType(params.legalEntityType)
  if (!entityType) {
    return { error: 'Den här företagsformen måste sättas upp manuellt.' }
  }

  // If the TIC lookup failed we don't know the company's VAT/F-skatt status.
  // Refuse to silently guess — the caller routes to the manual wizard so the
  // user can confirm these fields themselves.
  if (!params.lookup) {
    return { error: 'lookup_missing' }
  }

  // Ceased/struck-off companies must not be provisioned. Under BFL 2 kap,
  // bokföringsskyldighet ends when a company is avregistrerad; creating a
  // new gnubok accounting entity for a non-existent legal entity would let
  // users file momsdeklarationer or årsredovisning for it.
  if (params.lookup.isCeased) {
    return { error: 'company_ceased' }
  }

  // Look up the enrichment row so we can delete it after successful
  // provisioning (one-time use). We only need `id` here; the picker has
  // already used the `companyRoles` field server-side to render the cards.
  const { data: enrichmentRow } = await supabase
    .from('extension_data')
    .select('id')
    .eq('user_id', user.id)
    .eq('extension_id', 'tic')
    .eq('key', 'bankid_enrichment')
    .maybeSingle()

  const addressStreet = params.lookup.address?.street ?? null
  const addressPostal = params.lookup.address?.postalCode ?? null
  const addressCity = params.lookup.address?.city ?? null

  const fTax = params.lookup.registration.fTax
  const vatRegistered = params.lookup.registration.vat

  // moms_period: Skatteverket assigns the actual reporting period from
  // annual beskattningsunderlag (≤1 MSEK → yearly, ≤40 MSEK → quarterly,
  // >40 MSEK → monthly). TIC /lookup doesn't expose turnover, so we pick the
  // middle-tier default. The user must verify it matches their Skatteverket
  // assignment in /settings/tax — a mismatch causes late-filing penalties
  // under SFL.
  const momsPeriod = vatRegistered ? 'quarterly' : null

  // Default by entity_type: EF → kontantmetoden, AB → faktureringsmetoden.
  // Both forms may use either method under BFL 5 kap. 2 § when annual net
  // turnover is normally ≤ 3 MSEK; users can change in /settings/bookkeeping.
  const accountingMethod = entityType === 'enskild_firma' ? 'cash' : 'accrual'

  const settings: Record<string, unknown> = {
    entity_type: entityType,
    company_name: params.legalName,
    org_number: params.orgNumber.replace(/[\s-]/g, ''),
    f_skatt: fTax,
    vat_registered: vatRegistered,
    moms_period: momsPeriod,
    accounting_method: accountingMethod,
    fiscal_year_start_month: 1,
    address_line1: addressStreet,
    postal_code: addressPostal,
    city: addressCity,
  }

  const periodResult = computeFiscalPeriod(settings)
  if (periodResult.error) {
    return { error: 'Kunde inte beräkna räkenskapsår.' }
  }

  const result = await createCompanyFromOnboarding({
    teamId: params.teamId,
    settings,
    fiscalPeriod: {
      startDate: periodResult.startStr,
      endDate: periodResult.endStr,
      name: periodResult.periodName,
    },
  })

  if (result.error || !result.companyId) {
    return { error: result.error ?? 'Kunde inte skapa företag. Försök igen.' }
  }

  // One-time use: drop the enrichment row now that the user has committed to
  // a TIC-suggested company. The manual wizard intentionally does NOT do this
  // so a user with multiple directorships can still reach /select-company
  // afterwards and provision another one.
  if (enrichmentRow?.id) {
    await supabase.from('extension_data').delete().eq('id', enrichmentRow.id)
  }

  return { companyId: result.companyId }
}
