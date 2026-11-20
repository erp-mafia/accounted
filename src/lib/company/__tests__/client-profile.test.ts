/**
 * The byrå's profile pick for a client company (lib/company/client-profile.ts):
 * offered only to the client's byrå, preselected from what the company has,
 * stored at the profile's latest version, and shown to the invited client
 * only when the byrå prepared it.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readClientProfileChoice, readPreparedProfile, storeClientProfile } from '../client-profile'

const COMPANY = 'c0c0c0c0-0000-4000-8000-000000000001'

function db(opts: {
  company?: Record<string, unknown> | null
  companyError?: boolean
  teamKind?: string | null
  member?: boolean
}) {
  const mock = createTableMockSupabase({
    companies: opts.companyError
      ? { data: null, error: { message: 'column companies.profile_id does not exist' } as never }
      : { data: opts.company ?? null },
    teams: { data: opts.teamKind ? { kind: opts.teamKind } : null },
    team_members: { data: opts.member ? { role: 'admin' } : null },
  })
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

describe('readClientProfileChoice', () => {
  it('offers the choice to a member of the byrå team the company is on', async () => {
    const { client } = db({
      company: { team_id: 'team-1', profile_id: null, suggested_profile_id: 'limited-company-no-employees' },
      teamKind: 'byra',
      member: true,
    })
    expect(await readClientProfileChoice(client, COMPANY, 'user-1')).toEqual({
      current: null,
      preselected: 'limited-company-no-employees',
    })
  })

  it('preselects the stored profile first, and Standard for a company from before profiles', async () => {
    const stored = db({
      company: { team_id: 'team-1', profile_id: 'retail', suggested_profile_id: 'sole-trader' },
      teamKind: 'byra',
      member: true,
    })
    expect(await readClientProfileChoice(stored.client, COMPANY, 'user-1')).toEqual({ current: 'retail', preselected: 'retail' })
    const old = db({ company: { team_id: 'team-1', profile_id: null, suggested_profile_id: null }, teamKind: 'byra', member: true })
    expect(await readClientProfileChoice(old.client, COMPANY, 'user-1')).toEqual({ current: null, preselected: 'standard' })
  })

  it('offers nothing outside a byrå: no team, a personal team, or a user outside the team', async () => {
    const noTeam = db({ company: { team_id: null, profile_id: null, suggested_profile_id: null } })
    expect(await readClientProfileChoice(noTeam.client, COMPANY, 'user-1')).toBeNull()
    const personal = db({ company: { team_id: 'team-1' }, teamKind: 'personal', member: true })
    expect(await readClientProfileChoice(personal.client, COMPANY, 'user-1')).toBeNull()
    const outsider = db({ company: { team_id: 'team-1' }, teamKind: 'byra', member: false })
    expect(await readClientProfileChoice(outsider.client, COMPANY, 'user-1')).toBeNull()
  })

  it('offers nothing when the read fails, as on a database without the columns yet', async () => {
    const { client } = db({ companyError: true, teamKind: 'byra', member: true })
    expect(await readClientProfileChoice(client, COMPANY, 'user-1')).toBeNull()
  })
})

describe('storeClientProfile', () => {
  it('writes the id and the latest version on the company', async () => {
    const { client, payloads, findCall } = db({})
    expect(await storeClientProfile(client, COMPANY, 'association')).toEqual({ error: null })
    expect(payloads('companies', 'update')).toEqual([{ profile_id: 'association', profile_version: 1 }])
    expect(findCall('companies', 'eq')).toEqual(['id', COMPANY])
  })
})

describe('readPreparedProfile', () => {
  it('names the profile when a member of the byrå sent the invitation', async () => {
    const { client } = db({ company: { team_id: 'team-1', profile_id: 'sole-trader', profile_version: 1 }, teamKind: 'byra', member: true })
    expect(await readPreparedProfile(client, COMPANY, 'byra-user')).toEqual({
      id: 'sole-trader',
      name: 'Sole trader',
      name_sv: 'Enskild firma',
    })
  })

  it('says nothing without a stored profile, outside a byrå, from the client\'s own people, or on a failed read', async () => {
    const none = db({ company: { team_id: 'team-1', profile_id: null, profile_version: null }, teamKind: 'byra', member: true })
    expect(await readPreparedProfile(none.client, COMPANY, 'byra-user')).toBeNull()
    const personal = db({ company: { team_id: 'team-1', profile_id: 'retail', profile_version: 1 }, teamKind: 'personal', member: true })
    expect(await readPreparedProfile(personal.client, COMPANY, 'byra-user')).toBeNull()
    const client = db({ company: { team_id: 'team-1', profile_id: 'retail', profile_version: 1 }, teamKind: 'byra', member: false })
    expect(await readPreparedProfile(client.client, COMPANY, 'client-owner')).toBeNull()
    expect(await readPreparedProfile(client.client, COMPANY, null)).toBeNull()
    const failed = db({ companyError: true })
    expect(await readPreparedProfile(failed.client, COMPANY, 'byra-user')).toBeNull()
  })
})
