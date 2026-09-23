import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveCounterparty } from '../counterparty'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCall } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

const input = { companyId: 'co-1', userId: 'user-1', documentId: 'doc-1', citation: { page: 1, quote: 'Almi AB (559536-5064)' } }

beforeEach(() => {
  reset()
  rpc.mockClear()
})

describe('resolveCounterparty', () => {
  it('links a printed organisation number to the live party that carries it', async () => {
    enqueue({ data: { id: 'party-1' } })
    await expect(resolveCounterparty(supabase, { ...input, name: 'Almi Stockholm AB', orgNumber: '559536-5064' })).resolves.toEqual({ partyId: 'party-1', basis: 'proven', method: 'org_number', confidence: 1, created: false })
    expect(findCall('parties', 'eq')).toEqual(['company_id', 'co-1'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('suggests a party with the number and name as document facts when none exists, then links it', async () => {
    enqueue({ data: null }) // no party by org number
    enqueue({ data: {} }) // apply_party_suggestions
    enqueue({ data: { id: 'party-new' } }) // created
    await expect(resolveCounterparty(supabase, { ...input, name: 'Almi Stockholm AB', orgNumber: '5595365064' })).resolves.toMatchObject({ partyId: 'party-new', basis: 'proven', created: true })
    expect(rpc).toHaveBeenCalledWith('apply_party_suggestions', {
      p_company_id: 'co-1',
      p_user_id: 'user-1',
      p_items: [
        expect.objectContaining({
          display_name: 'Almi Stockholm AB',
          org_number: '5595365064',
          origin: 'document',
          facts: [
            { field: 'org_number', value: '5595365064', source: 'document', reference: { document_id: 'doc-1', page: 1, cited_text: 'Almi AB (559536-5064)' } },
            { field: 'legal_name', value: 'Almi Stockholm AB', source: 'document', reference: { document_id: 'doc-1', page: 1, cited_text: 'Almi AB (559536-5064)' } },
          ],
        }),
      ],
    })
  })

  it('treats an invalid organisation number as absent and falls back to the name', async () => {
    enqueue({ data: [{ id: 'party-2' }] }) // alias key
    enqueue({ data: [] }) // display name
    enqueue({ data: [] }) // legal name
    await expect(resolveCounterparty(supabase, { ...input, name: 'Kvarnen AB', orgNumber: '5595365065' })).resolves.toEqual({ partyId: 'party-2', basis: 'guessed', method: 'name', confidence: 0.7, created: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses to guess between two parties that fit the name', async () => {
    enqueue({ data: [{ id: 'party-2' }] })
    enqueue({ data: [{ id: 'party-3' }] })
    enqueue({ data: [] })
    await expect(resolveCounterparty(supabase, { ...input, name: 'Fortnox', orgNumber: null })).resolves.toEqual({ partyId: null, reason: 'ambiguous' })
  })

  it('suggests a party from the name alone and links it as a guess', async () => {
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: {} }) // rpc
    enqueue({ data: [{ id: 'party-4' }] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(resolveCounterparty(supabase, { ...input, name: 'Wasa Kredit AB', orgNumber: null })).resolves.toEqual({ partyId: 'party-4', basis: 'guessed', method: 'name', confidence: 0.6, created: true })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('has nothing to link without a name or number', async () => {
    await expect(resolveCounterparty(supabase, { ...input, name: '  ', orgNumber: null })).resolves.toEqual({ partyId: null, reason: 'no_identity' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
