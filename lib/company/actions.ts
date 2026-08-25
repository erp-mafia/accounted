'use server'

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { createCompanyCore } from '@/lib/company/create-company'
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

  // Steps 1-5 (company + owner via RPC, org number, TIC snapshot, chart,
  // settings, fiscal period, tax deadlines, with rollback) are shared with
  // the MCP and v1 creation paths: lib/company/create-company.ts.
  const created = await createCompanyCore(
    supabase,
    {
      entityType,
      companyName,
      orgNumber: params.settings.org_number as string | undefined,
      settings: params.settings,
      fiscalPeriod: params.fiscalPeriod,
      ticLookup: params.ticLookup,
    },
    () =>
      supabase.rpc('create_company_with_owner', {
        p_name: companyName,
        p_entity_type: entityType,
        p_team_id: params.teamId,
      }),
  )
  if (created.error !== undefined) {
    return { error: created.error }
  }
  const newCompanyId = created.companyId

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

