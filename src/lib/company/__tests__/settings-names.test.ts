import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCompanySettingsNames } from '../settings-names'

interface Call {
  table: string
  select: string
  column: string
  ids: string[]
}

/** A client that answers company_settings reads from `names` and records each filter it was given. */
function buildClient(names: Record<string, string | null>, failOnChunk?: number) {
  const calls: Call[] = []
  const from = vi.fn((table: string) => ({
    select: (select: string) => ({
      in: (column: string, ids: string[]) => {
        calls.push({ table, select, column, ids })
        if (failOnChunk === calls.length) return Promise.resolve({ data: null, error: { message: 'boom' } })
        return Promise.resolve({
          data: ids.filter((id) => id in names).map((id) => ({ company_id: id, company_name: names[id] })),
          error: null,
        })
      },
    }),
  }))
  return { client: { from } as unknown as SupabaseClient, calls, from }
}

describe('fetchCompanySettingsNames', () => {
  it('names the company ids instead of leaving the scoping to RLS', async () => {
    const { client, calls } = buildClient({ a: 'Alfa AB', b: null })
    await expect(fetchCompanySettingsNames(client, ['a', 'b'])).resolves.toEqual([
      { company_id: 'a', company_name: 'Alfa AB' },
      { company_id: 'b', company_name: null },
    ])
    expect(calls).toEqual([{ table: 'company_settings', select: 'company_id, company_name', column: 'company_id', ids: ['a', 'b'] }])
  })

  it('reads nothing when the caller has no companies', async () => {
    const { client, from } = buildClient({})
    await expect(fetchCompanySettingsNames(client, [])).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('asks for each company once and keeps every filter inside the query-string bound', async () => {
    const ids = Array.from({ length: 320 }, (_, i) => `co-${i}`)
    const { client, calls } = buildClient(Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])))
    const rows = await fetchCompanySettingsNames(client, [...ids, 'co-0', 'co-1'])
    expect(calls.map((c) => c.ids.length)).toEqual([150, 150, 20])
    expect(rows).toHaveLength(320)
    expect(new Set(rows.map((r) => r.company_id)).size).toBe(320)
  })

  it('keeps the names it could read when one read fails', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `co-${i}`)
    const { client } = buildClient(Object.fromEntries(ids.map((id) => [id, id])), 1)
    const rows = await fetchCompanySettingsNames(client, ids)
    expect(rows.map((r) => r.company_id)).toEqual(ids.slice(150))
  })
})
