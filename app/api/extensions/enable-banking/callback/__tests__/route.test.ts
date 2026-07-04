import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies: factory must not reference outer variables
const mockCreateSession = vi.fn()
const mockGetAccountBalance = vi.fn()
vi.mock('@/extensions/general/enable-banking/lib/api-client', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  getAccountBalance: (...args: unknown[]) => mockGetAccountBalance(...args),
}))

// Use hoisted to safely create mock objects referenced in vi.mock factories
const { mockFrom } = vi.hoisted(() => {
  const mockFrom = vi.fn()
  return { mockFrom }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockResolvedValue({
    from: mockFrom,
  }),
}))

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')

import { GET } from '../route'

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/extensions/enable-banking/callback')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return new Request(url.toString())
}

function mockChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'single', 'update', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  // For chains ending without .single()
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain
}

describe('GET /api/extensions/enable-banking/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when state does not match any pending connection', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({ data: null, error: { message: 'not found' } })
    )

    const response = await GET(makeRequest({ code: 'auth-code', state: 'unknown-state' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('bank_error=invalid_state')
  })

  it('writes pending_selection and redirects to picker on success', async () => {
    const capturedUpdates: Record<string, unknown>[] = []
    let callIndex = 0
    mockFrom.mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // Find pending connection by oauth_state
        return mockChain({ data: { id: 'conn-1', user_id: 'user-1', company_id: 'company-1' }, error: null })
      }
      // Update connection: capture the payload, then chain returns the
      // updated row via .select().single() for the audit event emission.
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capturedUpdates.push(payload)
        return chain
      })
      chain.eq = vi.fn().mockReturnValue(chain)
      chain.select = vi.fn().mockReturnValue(chain)
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'conn-1',
          bank_name: 'TestBank',
          company_id: 'company-1',
          user_id: 'user-1',
        },
        error: null,
      })
      // Back-compat fallthrough for chains that aren't terminated by .single()
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return chain
    })

    mockCreateSession.mockResolvedValue({
      session_id: 'sess-1',
      accounts: [
        { uid: 'acc-1', account_id: { iban: 'SE1234' }, name: 'Företagskonto', currency: 'SEK' },
        { uid: 'acc-2', account_id: { iban: 'SE5678' }, name: 'Privatkonto', currency: 'SEK' },
      ],
      access: { valid_until: '2024-12-31T00:00:00Z' },
      aspsp: { name: 'TestBank', country: 'SE' },
    })
    mockGetAccountBalance.mockRejectedValue(new Error('skip balance fetch'))

    const response = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('select_accounts=conn-1')
    expect(location).not.toContain('bank_connected=true')

    // Verify the update payload: status=pending_selection, no last_synced_at,
    // and every account defaults to enabled=true so the picker can simply
    // mirror current state without back-filling.
    expect(capturedUpdates).toHaveLength(1)
    const payload = capturedUpdates[0]
    expect(payload.status).toBe('pending_selection')
    expect(payload).not.toHaveProperty('last_synced_at')
    const accountsData = payload.accounts_data as Array<{ uid: string; enabled: boolean }>
    expect(accountsData).toHaveLength(2)
    expect(accountsData.every(a => a.enabled === true)).toBe(true)
  })

  it('redirects with error when bank returns error param (no state)', async () => {
    const response = await GET(makeRequest({ error: 'access_denied', error_description: 'User cancelled' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('bank_error=User%20cancelled')
    // No state → no DB cleanup attempted
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('cleans up pending connection when bank returns error with state', async () => {
    mockFrom.mockImplementation(() =>
      mockChain({ data: null, error: null })
    )

    const response = await GET(makeRequest({
      error: 'access_denied',
      error_description: 'Denied data sharing consent',
      state: 'pending-state',
    }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('bank_error=Denied%20data%20sharing%20consent')
    // Should clean up the pending row
    expect(mockFrom).toHaveBeenCalledWith('bank_connections')
  })

  it('redirects with error when code or state is missing', async () => {
    const response = await GET(makeRequest({ code: 'auth-code' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('bank_error=missing_parameters')
  })

  it('redirects with error when code fails format validation', async () => {
    const response = await GET(makeRequest({ code: '!!bad!!', state: 'some-state' }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/settings/banking?')
    expect(location).toContain('bank_error=invalid_code_format')
  })
})
