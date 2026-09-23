/**
 * gnubok_get_party: the party behind a supplier or customer for an agent.
 * The dossier itself is built by lib/parties (tested there); this checks the
 * argument contract and the row-to-party resolution.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const expandParty = vi.fn()
vi.mock('@/lib/parties/party-api', () => ({ expandParty: (...args: unknown[]) => expandParty(...args) }))

import { tools } from '../server'

const getParty = () => tools.find((t) => t.name === 'gnubok_get_party')!
const PARTY = { id: 'p-1', display_name: 'Webhallen Sverige AB', org_number: '5565588224', registry: { status: { label: 'Verksamt', active: true } } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_party', () => {
  it('is read-only and demands exactly one id', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(getParty().annotations).toMatchObject({ readOnlyHint: true })
    await expect(getParty().execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(/exactly one/)
    await expect(getParty().execute({ party_id: 'p-1', supplier_id: 's-1' }, 'company-1', 'user-1', supabase as never)).rejects.toThrow(/exactly one/)
    expect(expandParty).not.toHaveBeenCalled()
  })

  it('resolves a supplier to its party and scopes the lookup to the company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 's-1', party_id: 'p-1' } })
    expandParty.mockResolvedValue(PARTY)
    const result = await getParty().execute({ supplier_id: 's-1' }, 'company-1', 'user-1', supabase as never)
    expect(result).toEqual({ party: PARTY, found: true })
    expect(findCalls('suppliers', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['id', 's-1'],
    ])
    expect(expandParty).toHaveBeenCalledWith(supabase, 'company-1', 'p-1')
  })

  it('answers found:false for an unknown row, a row without a party, and a dismissed party', async () => {
    const { supabase, enqueue, reset } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await getParty().execute({ customer_id: 'c-9' }, 'company-1', 'user-1', supabase as never)).toEqual({ party: null, found: false })
    reset()
    enqueue({ data: { id: 'c-1', party_id: null } })
    expect(await getParty().execute({ customer_id: 'c-1' }, 'company-1', 'user-1', supabase as never)).toEqual({ party: null, found: false })
    expect(expandParty).not.toHaveBeenCalled()
    expandParty.mockResolvedValue(null)
    expect(await getParty().execute({ party_id: 'p-gone' }, 'company-1', 'user-1', supabase as never)).toEqual({ party: null, found: false })
  })
})
