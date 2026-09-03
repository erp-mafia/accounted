import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getDossier } from '../register'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const PARTY = '11111111-1111-4111-8111-111111111111'
const SURVIVOR = '22222222-2222-4222-8222-222222222222'

function row(over: Record<string, unknown>) {
  return {
    id: PARTY,
    display_name: 'Loopia AB',
    legal_name: null,
    org_number: null,
    vat_number: null,
    kind: 'company',
    status: 'suggested',
    alias_keys: ['loopia'],
    suggested_reason: null,
    created_at: '2026-09-03T00:00:00Z',
    merged_into: null,
    archived_at: null,
    ...over,
  }
}

describe('getDossier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('hides a dismissed (archived) party like the register does', async () => {
    enqueue({ data: row({ archived_at: '2026-09-03T10:00:00Z' }) })
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('follows a merged party to its survivor', async () => {
    enqueue({ data: row({ merged_into: SURVIVOR }) })
    enqueue({ data: SURVIVOR }) // canonical_party_id
    enqueue({ data: null }) // survivor lookup: absent, so the walk ends here
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('canonical_party_id', { p_party_id: PARTY })
    expect(supabase.from).toHaveBeenCalledTimes(2)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'parties')
  })

  it('returns null for an unknown id without touching anything else', async () => {
    enqueue({ data: null })
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
