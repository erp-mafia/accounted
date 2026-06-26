'use server'

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { normalizeVatNumber, isValidSwedishVatNumber, deriveSwedishVatNumber } from '@/lib/vat/vat-number'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

/**
 * Switch the active company. Returns an error *code* (translated by the
 * caller, same pattern as `org_number_invalid` below): 'not_member' when the
 * user lacks membership, 'persist_failed' when the user_preferences write
 * failed or could not be verified (#701).
 */
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
  } catch (err) {
    console.error('[switchCompany] failed', err)
    if (err instanceof CompanyContextError && err.code === 'not_member') {
      return { error: 'not_member' }
    }
    // persist_failed and anything unexpected: a retryable failure, not a
    // permissions problem — don't tell the user they lack access.
    return { error: 'persist_failed' }
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
  ticLookup?: CompanyLookupResult | null
}): Promise<{ companyId?: string; error?: string }> {
  try {
    return await createCompanyFromOnboardingImpl(params)
  } catch (err) {
    // Defensive top-level catch: a thrown error escapes to the client as
    // an opaque Next.js server-action exception with no message in dev
    // and a redacted message in prod. Logging the full error here gives
    // us a server-side trace and returns a localized fallback to the UI.
    console.error('[createCompanyFromOnboarding] unexpected error', err)
    const message = err instanceof Error ? err.message : String(err)
    return { error: message || 'Något gick fel när företaget skulle skapas. Försök igen.' }
  }
}

async function createCompanyFromOnboardingImpl(params: {
  teamId: string
  settings: Record<string, unknown>
  fiscalPeriod: { startDate: string; endDate: string; name: string }
  ticLookup?: CompanyLookupResult | null
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

  // Org-number format validation. We intentionally do NOT enforce
  // uniqueness: the same org number may legitimately appear on multiple
  // companies (a separate test copy of your real company, or a consultant
  // and the owner each tracking the same entity). Tenant isolation
  // (RLS + company_id) is the real boundary — not org-number uniqueness.
  //
  // normalizeOrgNumber returns null for malformed input — we refuse rather
  // than storing a value that would break SIE/SRU exports later.
  const rawOrgNumber = params.settings.org_number as string | undefined
  const cleanedOrgNumber = normalizeOrgNumber(rawOrgNumber)
  if (rawOrgNumber && rawOrgNumber.trim() && !cleanedOrgNumber) {
    return { error: 'org_number_invalid' }
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

  // Persist whatever lookup data the wizard already gathered. Do NOT call
  // /profile here — that handler fans out to 13 Lens calls and the 5 s
  // timeout in tic-fetch.ts ate ~530 wasted calls in May before yielding
  // zero snapshots (every signup's /profile timed out, but the in-flight
  // upstream fetches still counted against quota). The agent build path
  // (app/(onboarding)/onboarding/agent/page.tsx) calls ensureTicSnapshot
  // with upgradeV1: true lazily, which is the right place: only companies
  // that actually reach agent onboarding spend the budget.
  if (params.ticLookup) {
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

  // Defence in depth: this upsert bypasses UpdateSettingsSchema, so never persist
  // a VAT number blind. Normalise to the canonical SE+12 form; if it isn't
  // structurally valid (e.g. the legacy SE+14 personnummer derivation), re-derive
  // it from the org number, falling back to null rather than storing a malformed
  // momsregistreringsnummer.
  if (typeof settingsToSave.vat_number === 'string' && settingsToSave.vat_number) {
    const normalized = normalizeVatNumber(settingsToSave.vat_number)
    settingsToSave.vat_number = isValidSwedishVatNumber(normalized)
      ? normalized
      : deriveSwedishVatNumber(settingsToSave.org_number as string | null | undefined)
  }

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

