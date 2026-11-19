/**
 * The profile a byrå picks for a client company when it invites the client
 * (Profiles and Suggestions, step 2): mandatory in invitation onboarding,
 * stored on the client company (companies.profile_id), shown to the invited
 * client on /invite/[token] as "Din byrå har förberett: <profil>".
 *
 * A client company is one on a byrå team (companies.team_id, teams.kind =
 * 'byra'); the byrå is whoever is a member of that team. The client's own
 * people inviting someone pick nothing: the choice is the byrå's.
 *
 * Every read here takes the service client and answers null on any failure,
 * including a database that does not have the profile columns yet: the
 * invite flows then work exactly as before, without the choice.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  STANDARD_PROFILE_ID,
  getProfile,
  isProfileId,
  latestProfile,
  type ProfileId,
} from '@/lib/modules/profiles'

export interface ClientProfileChoice {
  /** The profile stored on the company; null when none is (Standard applies). */
  current: ProfileId | null
  /**
   * What the invite form preselects: the stored profile, else the one
   * company creation derived from the legal form, else Standard. A company
   * from before profiles has neither, so its byrå sees Standard, what it has
   * today, and narrows it only by picking another profile.
   */
  preselected: ProfileId
}

async function isByraMemberOf(serviceClient: SupabaseClient, teamId: string, userId: string): Promise<boolean> {
  const [{ data: team }, { data: member }] = await Promise.all([
    serviceClient.from('teams').select('kind').eq('id', teamId).maybeSingle(),
    serviceClient.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle(),
  ])
  return (team as { kind?: string } | null)?.kind === 'byra' && member !== null && member !== undefined
}

/**
 * The byrå's profile choice for one client company, for a user who may
 * invite: null unless the company is on a byrå team and the user is in that
 * team. Null on any failed read.
 */
export async function readClientProfileChoice(
  serviceClient: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<ClientProfileChoice | null> {
  try {
    const { data, error } = await serviceClient
      .from('companies')
      .select('team_id, profile_id, suggested_profile_id')
      .eq('id', companyId)
      .maybeSingle()
    if (error || !data) return null
    const company = data as { team_id: string | null; profile_id?: string | null; suggested_profile_id?: string | null }
    if (!company.team_id || !(await isByraMemberOf(serviceClient, company.team_id, userId))) return null
    const current = isProfileId(company.profile_id) ? company.profile_id : null
    const suggested = isProfileId(company.suggested_profile_id) ? company.suggested_profile_id : null
    return { current, preselected: current ?? suggested ?? STANDARD_PROFILE_ID }
  } catch {
    return null
  }
}

/** Store the byrå's pick on the client company, at the profile's latest version. */
export async function storeClientProfile(
  serviceClient: SupabaseClient,
  companyId: string,
  profileId: ProfileId,
): Promise<{ error: unknown }> {
  const { error } = await serviceClient
    .from('companies')
    .update({ profile_id: profileId, profile_version: latestProfile(profileId).version })
    .eq('id', companyId)
  return { error }
}

/** The profile as the invite page shows it. */
export interface PreparedProfile {
  id: ProfileId
  name: string
  name_sv: string
}

/**
 * The profile a byrå prepared for the company an invitation is for: the
 * company's stored profile, when the company is on a byrå team and the
 * invitation was sent by a member of that team. Null otherwise (no stored
 * profile, not a byrå client, invited by the client's own people) and on any
 * failed read, so the invite page never says "your byrå" about anyone else.
 */
export async function readPreparedProfile(
  serviceClient: SupabaseClient,
  companyId: string,
  invitedBy: string | null | undefined,
): Promise<PreparedProfile | null> {
  if (!invitedBy) return null
  try {
    const { data, error } = await serviceClient
      .from('companies')
      .select('team_id, profile_id, profile_version')
      .eq('id', companyId)
      .maybeSingle()
    if (error || !data) return null
    const company = data as { team_id: string | null; profile_id?: string | null; profile_version?: number | null }
    if (!company.team_id || !company.profile_id || !company.profile_version) return null
    const profile = getProfile(company.profile_id, company.profile_version)
    if (!profile) return null
    if (!(await isByraMemberOf(serviceClient, company.team_id, invitedBy))) return null
    return { id: profile.id, name: profile.name, name_sv: profile.nameSv }
  } catch {
    return null
  }
}
