import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { actingByraName } from '../acting-byra'

const USER = '44444444-4444-4444-8444-444444444444'

let db: ReturnType<typeof createTableMockSupabase>
let service: SupabaseClient

beforeEach(() => {
  db = createTableMockSupabase()
  service = db.supabase as unknown as SupabaseClient
})

describe('actingByraName', () => {
  it('names a byrå team the user is a member of, trimmed, as an object or a list', async () => {
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: ' Byrån AB ', kind: 'byra' } } })
    expect(await actingByraName(service, 'team-1', USER)).toBe('Byrån AB')
    db.setTable('team_members', { data: { team_id: 'team-1', teams: [{ name: 'Byrån i lista AB', kind: 'byra' }] } })
    expect(await actingByraName(service, 'team-1', USER)).toBe('Byrån i lista AB')
  })

  it('never counts a personal team, a blank name or a missing membership', async () => {
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: 'Personal', kind: 'personal' } } })
    expect(await actingByraName(service, 'team-1', USER)).toBeNull()
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: '  ', kind: 'byra' } } })
    expect(await actingByraName(service, 'team-1', USER)).toBeNull()
    db.setTable('team_members', { data: null })
    expect(await actingByraName(service, 'team-1', USER)).toBeNull()
  })

  it('does not look anything up for a company without a team', async () => {
    expect(await actingByraName(service, null, USER)).toBeNull()
    expect(db.supabase.from).not.toHaveBeenCalled()
  })
})
