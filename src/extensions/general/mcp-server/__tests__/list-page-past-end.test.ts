import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { tools } from '../server'

// supabase-js resolves a WebSocket when it builds its realtime client; Node 20
// (CI) has none. Nothing here subscribes, so an inert one is enough.
beforeEach(() => {
  if (!('WebSocket' in globalThis)) vi.stubGlobal('WebSocket', class {})
})

// A page past the last row of an offset-paginated list used to answer
// UNKNOWN_ERROR "Database error: Requested range not satisfiable": PostgREST
// refuses a counted read whose offset lies past the last row with 416
// PGRST103. These run the list tools on a real supabase-js server client
// (lib/supabase/page-past-end.ts normalises the refusal in its fetch) against
// a PostgREST stand-in that answers exactly that refusal for the paged table.

const tool = (name: string) => tools.find((t) => t.name === name)!

function postgrestStandIn(pagedTable: string, total: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const table = url.pathname.split('/rest/v1/')[1]
    const offset = Number(url.searchParams.get('offset') ?? 0)
    if (table === pagedTable && offset > total) {
      return new Response(
        JSON.stringify({
          code: 'PGRST103',
          details: `An offset of ${offset} was requested, but there are only ${total} rows.`,
          hint: null,
          message: 'Requested range not satisfiable',
        }),
        { status: 416, headers: { 'content-type': 'application/json; charset=utf-8', 'content-range': `*/${total}` } },
      )
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } })
  })
}

function clientFor(pagedTable: string, total: number) {
  const fetchMock = postgrestStandIn(pagedTable, total)
  const supabase = createServiceRoleClient('https://project.supabase.co', 'service-role-key', {
    global: { fetch: fetchMock },
  }) as SupabaseClient
  return { supabase, fetchMock }
}

describe('list tools paged past the last row answer an empty page, never a database error', () => {
  it('gnubok_list_uncategorized_transactions', async () => {
    const { supabase, fetchMock } = clientFor('open_bank_rows', 25)

    const result = (await tool('gnubok_list_uncategorized_transactions').execute(
      { limit: 20, offset: 40 },
      'company-1',
      'user-1',
      supabase,
    )) as { transactions: unknown[]; total_count: number; has_more: boolean; next_offset?: number }

    expect(fetchMock).toHaveBeenCalled()
    expect(result.transactions).toEqual([])
    expect(result.total_count).toBe(25)
    expect(result.has_more).toBe(false)
    expect(result.next_offset).toBeUndefined()
  })

  it('gnubok_list_pending_operations', async () => {
    const { supabase } = clientFor('pending_operations', 3)

    const result = (await tool('gnubok_list_pending_operations').execute(
      { offset: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { operations: unknown[]; total_count: number; has_more: boolean }

    expect(result.operations).toEqual([])
    expect(result.total_count).toBe(3)
    expect(result.has_more).toBe(false)
  })

  it('gnubok_list_records', async () => {
    const { supabase } = clientFor('document_attachments', 12)

    const result = (await tool('gnubok_list_records').execute(
      { offset: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as { items: unknown[]; total: number; next_offset: number | null }

    expect(result).toEqual({ items: [], total: 12, next_offset: null })
  })

  it('gnubok_list_invoices', async () => {
    const { supabase } = clientFor('invoices', 7)

    const result = (await tool('gnubok_list_invoices').execute(
      { offset: 40 },
      'company-1',
      'user-1',
      supabase,
    )) as { invoices: unknown[]; total_count: number; has_more: boolean }

    expect(result.invoices).toEqual([])
    expect(result.total_count).toBe(7)
    expect(result.has_more).toBe(false)
  })
})
