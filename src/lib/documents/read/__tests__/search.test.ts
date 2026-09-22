import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { searchDocumentPages } from '../search'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc
const hit = { document_id: 'doc-1', page_no: 6, file_name: 'Almilånedokument.pdf', headline: '<b>Almi</b>', rank: 0.1 }

beforeEach(() => {
  reset()
  rpc.mockClear()
})

describe('searchDocumentPages', () => {
  it('returns what every word finds', async () => {
    enqueue({ data: [hit] })
    expect(await searchDocumentPages(supabase, 'co-1', 'Almi kredit', 10)).toEqual([hit])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('search_document_pages', { p_company_id: 'co-1', p_query: 'Almi kredit', p_limit: 10 })
  })

  it('retries a query of several words with any of them when all of them find nothing', async () => {
    enqueue({ data: [] })
    enqueue({ data: [hit] })
    expect(await searchDocumentPages(supabase, 'co-1', 'Almi lån', 10)).toEqual([hit])
    expect(rpc).toHaveBeenLastCalledWith('search_document_pages', { p_company_id: 'co-1', p_query: 'Almi or lån', p_limit: 10 })
  })

  it('does not retry a single word, and throws when the search fails', async () => {
    enqueue({ data: [] })
    expect(await searchDocumentPages(supabase, 'co-1', 'Almi', 10)).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(1)
    enqueue({ error: { message: 'syntax error in tsquery' } })
    await expect(searchDocumentPages(supabase, 'co-1', 'Almi', 10)).rejects.toThrow('page search failed: syntax error in tsquery')
  })
})
