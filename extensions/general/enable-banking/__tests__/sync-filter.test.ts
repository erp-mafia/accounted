import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import { enableBankingExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

const syncRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/sync'
)

if (!syncRoute) {
  throw new Error('POST /sync route not registered on enable-banking extension')
}

function makeContext(connectionRow: {
  status: string
  accounts_data: StoredAccount[]
}): ExtensionContext {
  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'conn-1', company_id: 'company-1', ...connectionRow },
        error: null,
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  }

  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    storage: {} as never,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    services: {} as never,
  }
}

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: 'conn-1' }),
  })
}

describe('POST /sync (enable-banking): account filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when status is pending_selection', async () => {
    const ctx = makeContext({
      status: 'pending_selection',
      accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
    })

    const res = await syncRoute.handler(makeRequest(), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not active/i)
  })

  it('returns 400 when every account is disabled', async () => {
    const ctx = makeContext({
      status: 'active',
      accounts_data: [
        { uid: 'acc-1', currency: 'SEK', enabled: false },
        { uid: 'acc-2', currency: 'SEK', enabled: false },
      ],
    })

    const res = await syncRoute.handler(makeRequest(), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Inga konton är valda/i)
  })
})
