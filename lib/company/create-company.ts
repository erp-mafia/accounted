import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { normalizeVatNumber, isValidSwedishVatNumber, deriveSwedishVatNumber } from '@/lib/vat/vat-number'
import { regenerateTaxDeadlinesForUser, toDeadlineSettings } from '@/lib/tax/deadline-generator'
import type { CompanySettingsForDeadlines } from '@/lib/tax/deadline-config'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import type { EntityType } from '@/types'

/**
 * The one company-creation sequence, shared by the web wizard (Server
 * Action, cookie session, create_company_with_owner), the MCP tool
 * gnubok_create_company and POST /api/v1/companies (service client,
 * create_company_for_user). Issue #1814 PR 3.
 *
 * All steps after the company row exists roll back on failure so a company
 * never survives half-configured: bookkeeping duty under BFL starts the
 * moment the tenant is real, and a company without a chart, a fiscal period
 * or its tax deadlines is worse than no company.
 *
 * The caller supplies `createCompanyRow`, the RPC call that inserts the
 * company + owner membership: which RPC is right depends on whether the
 * caller has an auth.uid() (cookie session) or an explicit owner (service
 * role). Everything else is identical.
 */
export interface CreateCompanyInput {
  entityType: EntityType
  companyName: string
  /** Raw org number as typed; normalised here, refused when malformed. */
  orgNumber?: string | null
  /**
   * company_settings partial to persist. UI-only and managed fields are
   * stripped here (id, user_id, company_id, timestamps, first-fiscal-year
   * helpers), so callers may pass the wizard state as-is.
   */
  settings: Record<string, unknown>
  fiscalPeriod: { startDate: string; endDate: string; name: string }
  ticLookup?: CompanyLookupResult | null
}

export type CreateCompanyResult = { companyId: string; error?: undefined } | { companyId?: undefined; error: string }

export const COMPANY_CREATION_ERRORS = {
  org_number_invalid: 'org_number_invalid',
  create_failed: 'Kunde inte skapa företag. Försök igen.',
  org_number_save_failed: 'Kunde inte spara organisationsnummer. Försök igen.',
  chart_failed: 'Kunde inte skapa kontoplan. Försök igen.',
  settings_failed: 'Kunde inte spara inställningar. Försök igen.',
  period_failed: 'Kunde inte skapa räkenskapsår. Försök igen.',
  deadlines_failed: 'Kunde inte skapa skattedeadlines. Försök igen.',
} as const

export async function createCompanyCore(
  supabase: SupabaseClient,
  input: CreateCompanyInput,
  createCompanyRow: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<CreateCompanyResult> {
  // Org-number format validation. We intentionally do NOT enforce
  // uniqueness: the same org number may legitimately appear on multiple
  // companies (a separate test copy of your real company, or a consultant
  // and the owner each tracking the same entity). Tenant isolation
  // (RLS + company_id) is the real boundary, not org-number uniqueness.
  //
  // normalizeOrgNumber returns null for malformed input: we refuse rather
  // than storing a value that would break SIE/SRU exports later.
  const rawOrgNumber = input.orgNumber ?? undefined
  const cleanedOrgNumber = normalizeOrgNumber(rawOrgNumber)
  if (rawOrgNumber && rawOrgNumber.trim() && !cleanedOrgNumber) {
    return { error: COMPANY_CREATION_ERRORS.org_number_invalid }
  }

  // 1. Create company + owner membership atomically via RPC
  const { data: newCompanyIdRaw, error: companyError } = await createCompanyRow()
  const newCompanyId = typeof newCompanyIdRaw === 'string' ? newCompanyIdRaw : null

  if (companyError || !newCompanyId) {
    console.error('[createCompany] company creation failed', companyError)
    return { error: COMPANY_CREATION_ERRORS.create_failed }
  }

  // Helper: roll back the company if a subsequent step fails. Deletes in FK
  // order. Each delete is error-checked so a failed cleanup leaves a trace
  // instead of silently stranding partial company data behind a generic
  // "try again" message.
  const rollback = async (reason: string, err: unknown) => {
    console.error(`[createCompany] rolling back ${newCompanyId}: ${reason}`, err)
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
          `[createCompany] rollback delete failed for ${table} (company ${newCompanyId})`,
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
      return { error: COMPANY_CREATION_ERRORS.org_number_save_failed }
    }
  }

  // Persist whatever lookup data the caller already gathered. Do NOT call
  // /profile here: that handler fans out to 13 Lens calls and the 5 s
  // timeout in tic-fetch.ts ate ~530 wasted calls in May before yielding
  // zero snapshots (every signup's /profile timed out, but the in-flight
  // upstream fetches still counted against quota). The agent build path
  // (app/(onboarding)/onboarding/agent/page.tsx) calls ensureTicSnapshot
  // with upgradeV1: true lazily, which is the right place: only companies
  // that actually reach agent onboarding spend the budget.
  if (input.ticLookup) {
    const { error: ticErr } = await supabase
      .from('companies')
      .update({
        tic_snapshot: input.ticLookup,
        tic_snapshot_fetched_at: new Date().toISOString(),
      })
      .eq('id', newCompanyId)
    if (ticErr) {
      console.warn('[createCompany] tic snapshot persist failed', ticErr)
    }
  }

  // 2. Seed chart of accounts
  const { error: coaError } = await supabase.rpc('seed_chart_of_accounts', {
    p_company_id: newCompanyId,
    p_entity_type: input.entityType,
  })
  if (coaError) {
    await rollback('COA seeding failed', coaError)
    return { error: COMPANY_CREATION_ERRORS.chart_failed }
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
  } = input.settings

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
    return { error: COMPANY_CREATION_ERRORS.settings_failed }
  }

  // 4. Create fiscal period
  const { error: periodError } = await supabase.from('fiscal_periods').upsert(
    {
      company_id: newCompanyId,
      name: input.fiscalPeriod.name,
      period_start: input.fiscalPeriod.startDate,
      period_end: input.fiscalPeriod.endDate,
    },
    { onConflict: 'company_id,period_start,period_end' },
  )

  if (periodError) {
    await rollback('fiscal period upsert failed', periodError)
    return { error: COMPANY_CREATION_ERRORS.period_failed }
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
    return { error: COMPANY_CREATION_ERRORS.deadlines_failed }
  }

  return { companyId: newCompanyId }
}
