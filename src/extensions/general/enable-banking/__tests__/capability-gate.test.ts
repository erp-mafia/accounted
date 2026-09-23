import { describe, it, expect, vi, beforeEach } from 'vitest'

// Force the gate to run (no dev bypass) but stub requireCapability so we control
// entitlement per test. Mirrors the skatteverket capability-gate suite.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn() }
})

import { enableBankingExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { ExtensionContext } from '@/lib/extensions/types'

// The interactive bank-sync entry points gated on CAPABILITY.bank_sync.
const GATED: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/connect' },
  { method: 'POST', path: '/sync' },
]

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      },
      from: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('enable-banking paywall gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(GATED)(
    '$method $path returns 403 capability_blocked when not entitled',
    async ({ method, path }) => {
      vi.mocked(requireCapability).mockResolvedValue(
        capabilityBlockedResponse(CAPABILITY.bank_sync),
      )
      const route = enableBankingExtension.apiRoutes?.find(
        (r) => r.method === method && r.path === path,
      )
      expect(route, `${method} ${path} must be registered`).toBeDefined()

      const request = new Request(
        `https://test.local/api/extensions/ext/enable-banking${path}`,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      const response = await route!.handler(request, makeContext())

      expect(response.status).toBe(403)
      const body = (await response.json()) as {
        capability_blocked?: boolean
        capability?: string
      }
      expect(body.capability_blocked).toBe(true)
      expect(body.capability).toBe(CAPABILITY.bank_sync)
    },
  )
})
