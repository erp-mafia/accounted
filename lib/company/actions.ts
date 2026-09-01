'use server'

import { headers } from 'next/headers'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { revalidatePath } from 'next/cache'
import { createCompanyCore } from '@/lib/company/create-company'
import type { SupabaseClient } from '@supabase/supabase-js'
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
    if (err instanceof CompanyContextError && err.code === 'company_locked') {
      // Multi-user seat gate: the company is frozen for this (non-owner)
      // membership until someone pays. Translated by the caller.
      return { error: 'company_locked' }
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

  // Creating a company under a BYRÅ team is admin-gated (WL-15): every
  // created client company is +1 on the byrå's monthly invoice, so only team
  // owner/admin may do it. Personal-team creation is untouched. The
  // create_company_with_owner RPC enforces the same rule in the database
  // (migration 20260826130400); this check exists to return a readable error
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

  // Brand-host signup homing (2026-08-27): when this wizard runs on an
  // invite-only brand host and the creating user is on the brand's signup
  // allowlist, the company attaches to the brand's byrå team via the
  // create_company_for_brand_signup RPC (which re-checks the allowlist).
  // Without this the company would get the personal team and the home-domain
  // rule (WL-01) would home it on the canonical domain, invisible on the
  // very brand domain the user signed up on. Only the personal-team path is
  // rerouted: an explicit byrå-team creation (the cockpit's new-client flow)
  // already passed the byrå team and stays under the WL-15 admin gate above.
  let createCompanyRow: () => PromiseLike<{ data: unknown; error: unknown }> =
    () =>
      supabase.rpc('create_company_with_owner', {
        p_name: companyName,
        p_entity_type: entityType,
        p_team_id: params.teamId,
      })
  // When the row is created under the service role (brand-signup path below),
  // rollback must also run under the service role: `companies` has RLS and no
  // FOR DELETE policy, so a cookie-session rollback of a service-created
  // company deletes nothing and strands a member-less orphan on the brand's
  // team. Stays null on the normal path, where the session client is correct.
  // Once the rollback delete lands, user_preferences.active_company_id (which
  // the RPC set) auto-clears via its ON DELETE SET NULL FK, so no dangling
  // active company survives.
  let rollbackClient: SupabaseClient | undefined

  if ((teamRow as { kind?: string } | null)?.kind !== 'byra' && user.email) {
    // Dynamic imports: this file is imported by client components (through
    // switch-client.ts) for its other actions, and these two modules reach
    // node:crypto; a static import would drag Node builtins into the client
    // graph (client-node-builtin guard). Server actions always execute
    // server-side, so the dynamic import is free here.
    const [{ resolveBrandByHost }, { isEmailOnBrandAllowlist }] = await Promise.all([
      import('@/lib/branding/resolve'),
      import('@/lib/auth/brand-signup-gate'),
    ])
    const requestHeaders = await headers()
    const host =
      requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? ''
    const hostBrand = host ? await resolveBrandByHost(host) : null
    if (
      hostBrand?.signupMode === 'invite_only' &&
      (await isEmailOnBrandAllowlist(hostBrand.id, user.email))
    ) {
      const serviceClient = createServiceClient()
      rollbackClient = serviceClient
      createCompanyRow = () =>
        serviceClient.rpc('create_company_for_brand_signup', {
          p_user_id: user.id,
          p_name: companyName,
          p_entity_type: entityType,
          p_brand_id: hostBrand.id,
        })
    }
  }

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
    createCompanyRow,
    rollbackClient,
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

