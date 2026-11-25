import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({
  resolveRequestAppOrigin: vi.fn(async () => 'http://localhost:3000'),
}))

import { GET } from '../return/route'
import { buildAuthorizeUrl } from '@/extensions/general/woocommerce/lib/connect'
import { createServiceClient, createClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createQueuedMockSupabase } from '@/tests/helpers'

const INITIATOR = 'user-initiator'
const STATE = '123e4567-e89b-12d3-a456-426614174000'

describe('wc-auth approver binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.mocked(extensionRegistry.get).mockResolvedValue(
      { id: 'woocommerce' } as Awaited<ReturnType<typeof extensionRegistry.get>>,
    )
  })

  it('does not activate a store from the initiator browser alone, with nothing from the approving store admin', async () => {
    // Everything the return leg needs is in the authorize URL the initiator
    // receives from POST /connect: the return URL and the state.
    const authorize = new URL(
      buildAuthorizeUrl('https://store.example', STATE, 'http://localhost:3000'),
    )
    const returnUrl = new URL(authorize.searchParams.get('return_url')!)
    returnUrl.searchParams.set('success', '1')
    returnUrl.searchParams.set('user_id', authorize.searchParams.get('user_id')!)

    // Someone else approved in wp-admin: the callback staged the store's keys
    // on the initiator's pending row. The initiator's own browser opens the
    // return URL.
    const queued = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockResolvedValue(queued.supabase as never)
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: INITIATOR } }, error: null }),
      },
    } as never)
    queued.enqueue({
      data: { id: 'conn-1', user_id: INITIATOR, status: 'pending', created_at: new Date().toISOString() },
    })
    queued.enqueue({ data: null }) // browser_confirmed_at
    queued.enqueue({
      data: { id: 'conn-1', company_id: 'company-x', user_id: INITIATOR, store_url: 'https://store.example' },
    }) // activation flip matched: keys staged

    const res = await GET(new Request(returnUrl.toString()))

    const activation = queued
      .findCalls('woocommerce_connections', 'update')
      .find((c) => (c[0] as Record<string, unknown>).status === 'active')
    // Expected: no activation without proof that the initiator controls the
    // store. Actual on main: the row flips to active and the panel toasts.
    expect(activation).toBeUndefined()
    expect(res.headers.get('location')).not.toContain('woocommerce_connected=true')
  })
})
