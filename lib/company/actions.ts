'use server'

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { normalizeVatNumber, isValidSwedishVatNumber, deriveSwedishVatNumber } from '@/lib/vat/vat-number'
import {
  regenerateTaxDeadlinesForUser,
  toDeadlineSettings,
} from '@/lib/tax/deadline-generator'
import type { CompanySettingsForDeadlines } from '@/lib/tax/deadline-config'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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
    // No revalidatePath: the client performs a hard navigation
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
    // permissions problem: don't tell the user they lack access.
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
    return { error: getErrorMessage(err, { context: 'settings' }) }
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
  // (RLS + company_id) is the real boundary, not org-number uniqueness.
  //
  // normalizeOrgNumber returns null for malformed input: we refuse rather
  // than storing a value that would break SIE/SRU exports later.
  const rawOrgNumber = params.settings.org_number as string | undefined
  const cleanedOrgNumber = normalizeOrgNumber(rawOrgNumber)
  if (rawOrgNumber && rawOrgNumber.trim() && !cleanedOrgNumber) {
    return { error: 'org_number_invalid' }
  }

  // Creating a company under a BYRÅ team is admin-gated (WL-15): every
  // created client company is +1 on the byrå's monthly invoice, so only team
  // owner/admin may do it. Personal-team creation is untouched. The
  // create_company_with_owner RPC enforces the same rule in the database
  // (migration 20260804113000); this check exists to return a readable error
  // instead of a raw 42501. A team the caller cannot read via RLS resolves
  // to null kind here and falls through to the RPC's own membership check.
  const { data: teamRow } = await supabase
    .from('teams')
    .select('kind')
    .eq('id', params.teamId)
    .maybeSingle()
  if ((teamRow as { kind?: string } | null)?.kind === 'byra') {
    const { data: teamMemberRow } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', params.teamId)
      .eq('user_id', user.id)
      .maybeSingle()
    const teamRole = (teamMemberRow as { role?: string } | null)?.role
    if (teamRole !== 'owner' && teamRole !== 'admin') {
      return { error: 'Endast byråns ägare och administratörer kan skapa klientbolag.' }
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

  // Helper: roll back the company if a subsequent step fails. Deletes in FK
  // order. Each delete is error-checked so a failed cleanup leaves a trace
  // instead of silently stranding partial company data behind a generic
  // "try again" message.
  const rollback = async (reason: string, err: unknown) => {
    console.error(`[createCompanyFromOnboarding] rolling back ${newCompanyId}: ${reason}`, err)
    const deletions: Array<[table: string, run: () => PromiseLike<{ error: unknown }>]> = [
      ['company_settings', () => supabase.from('company_settings').delete().eq('company_id', newCompanyId)],
      ['fiscal_periods', () => supabase.from('fiscal_periods').delete().eq('company_id', newCompanyId)],
      ['chart_of_accounts', () => supabase.from('chart_of_accounts').delete().eq('company_id', newCompanyId)],
      ['company_members', () => supabase.from('company_members').delete().eq('company_id', newCompanyId)],
      ['companies', () => supabase.from('companies').delete().eq('id', newCompanyId)],
    ]
    for (const [table, run] of deletions) {
      const { error: deleteError } = await run()
      if (deleteError) {
        console.error(
          `[createCompanyFromOnboarding] rollback delete failed for ${table} (company ${newCompanyId})`,
          deleteError,
        )
      }
    }
  }

  // Mirror the normalized org_number onto the companies row so future
  // duplicate checks and cross-references are reliable. MUST be error-checked
  // and rolled back on failure: otherwise the freshly-created company would
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
  // /profile here: that handler fans out to 13 Lens calls and the 5 s
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

  // 5. Create the automatic tax deadlines while the onboarding data is still
  // available. Treat this as part of company creation so a new company never
  // starts in the broken state where valid settings exist without deadlines.
  try {
    await regenerateTaxDeadlinesForUser(
      supabase,
      newCompanyId,
      toDeadlineSettings(settingsToSave as Partial<CompanySettingsForDeadlines>),
    )
  } catch (deadlineError) {
    await rollback('tax deadline generation failed', deadlineError)
    return { error: 'Kunde inte skapa skattedeadlines. Försök igen.' }
  }

  // 6. Set as active company
  try {
    await setActiveCompany(supabase, user.id, newCompanyId)
  } catch (err) {
    // Non-fatal: the company was created successfully; the user can switch manually
    console.error('[createCompanyFromOnboarding] setActiveCompany failed', err)
  }

  revalidatePath('/')
  return { companyId: newCompanyId }
}

