/**
 * POST /api/parties/aliases: a person corrects what bank strings mean. The
 * write policies on counterparty_aliases check membership only, so the route's
 * requireWrite is what keeps a viewer out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { POST } from '../route'
import { getActiveCompanyId } from '@/lib/company/context'

const user = { id: 'user-1', email: 'test@test.se' }
const noParams = { params: Promise.resolve({}) }
const call = (body: unknown) => POST(createMockRequest('/api/parties/aliases', { method: 'POST', body }), noParams)

// The resolver reports the caller's role on the facts object it is handed;
// withRouteContext's write guard reads it from there.
function asRole(role: string) {
  vi.mocked(getActiveCompanyId).mockImplementation(async (_s: unknown, _u: unknown, resolved?: { role?: string }) => {
    if (resolved) resolved.role = role
    return 'company-1'
  })
}

const LIVE = {
  id: 'alias-1',
  alias_key: 'kortkop webhallen',
  sample_text: 'KORTKOP WEBHALLEN',
  display_name: 'Webhalen',
  kind: 'merchant',
  rail: null,
  country: 'SE',
  what: 'elektronik',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
  asRole('member')
})

describe('POST /api/parties/aliases', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
    const { status } = await parseJsonResponse(await call({ aliasKeys: ['kortkop webhallen'], action: 'not_same' }))
    expect(status).toBe(401)
    expect(findCall('counterparty_aliases', 'insert')).toBeUndefined()
  })

  it('answers 403 to a viewer and writes nothing', async () => {
    asRole('viewer')
    const { status } = await parseJsonResponse(await call({ aliasKeys: ['kortkop webhallen'], action: 'not_same' }))
    expect(status).toBe(403)
    expect(findCall('counterparty_aliases', 'select')).toBeUndefined()
    expect(findCall('counterparty_aliases', 'update')).toBeUndefined()
    expect(findCall('counterparty_aliases', 'insert')).toBeUndefined()
  })

  it('answers 400 to a rename without a name', async () => {
    const { status } = await parseJsonResponse(await call({ aliasKeys: ['kortkop webhallen'], action: 'rename' }))
    expect(status).toBe(400)
  })

  it('answers 404 when no live alias carries the keys', async () => {
    enqueue({ data: [] })
    const { status } = await parseJsonResponse(await call({ aliasKeys: ['okand'], action: 'not_same' }))
    expect(status).toBe(404)
    expect(findCall('counterparty_aliases', 'insert')).toBeUndefined()
  })

  it('lets a member rename: supersedes the live row and records the answer', async () => {
    enqueue({ data: [LIVE] }) // live aliases
    enqueue({ data: { id: 'party-9' } }) // party carrying the name
    enqueue({ data: null }) // supersede
    enqueue({ data: null }) // insert
    const { status, body } = await parseJsonResponse<{ data: { updated: number; partyId: string | null } }>(
      await call({ aliasKeys: ['kortkop webhallen'], action: 'rename', name: 'Webhallen' }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ updated: 1, partyId: 'party-9' })
    expect(findCalls('counterparty_aliases', 'update')[0][0]).toMatchObject({ human_outcome: 'disagree' })
    expect(findCall('counterparty_aliases', 'insert')?.[0]).toEqual([
      expect.objectContaining({
        company_id: 'company-1',
        user_id: 'user-1',
        alias_key: 'kortkop webhallen',
        party_id: 'party-9',
        display_name: 'Webhallen',
        source: 'person',
        confidence: 1,
        band: 'link',
        verified: true,
      }),
    ])
  })
})
