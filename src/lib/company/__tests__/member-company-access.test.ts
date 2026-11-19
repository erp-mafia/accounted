import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  ChosenCompanyIdsSchema,
  filterTeamClientCompanyIds,
} from '../member-company-access'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  reset()
})

describe('ChosenCompanyIdsSchema', () => {
  it('drops duplicates and keeps the order', () => {
    expect(ChosenCompanyIdsSchema.parse([uuid(2), uuid(1), uuid(2)])).toEqual([uuid(2), uuid(1)])
  })

  it('refuses an empty choice and non-uuid ids', () => {
    expect(ChosenCompanyIdsSchema.safeParse([]).success).toBe(false)
    expect(ChosenCompanyIdsSchema.safeParse(['co-1']).success).toBe(false)
  })
})

describe('filterTeamClientCompanyIds', () => {
  it('keeps only the team clients, in input order', async () => {
    enqueue({ data: [{ id: uuid(3) }, { id: uuid(1) }] })
    await expect(
      filterTeamClientCompanyIds(client, 'team-1', [uuid(1), uuid(2), uuid(3)]),
    ).resolves.toEqual([uuid(1), uuid(3)])
    expect(findCalls('companies', 'eq')).toContainEqual(['team_id', 'team-1'])
    expect(findCalls('companies', 'is')).toContainEqual(['archived_at', null])
  })

  it('splits a long choice into several IN filters', async () => {
    const ids = Array.from({ length: 160 }, (_, i) => uuid(i))
    enqueue({ data: ids.slice(0, 150).map((id) => ({ id })) })
    enqueue({ data: ids.slice(150).map((id) => ({ id })) })
    await expect(filterTeamClientCompanyIds(client, 'team-1', ids)).resolves.toEqual(ids)
    expect(findCalls('companies', 'in')).toHaveLength(2)
  })

  it('throws on a read error instead of reporting the ids as foreign', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(filterTeamClientCompanyIds(client, 'team-1', [uuid(1)])).rejects.toBeTruthy()
  })
})
