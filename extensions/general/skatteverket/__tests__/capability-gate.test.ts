import { describe, it, expect, vi, beforeEach } from 'vitest'

// Force the gate itself to run (no dev bypass), but stub the resolver so we
// control entitlement per test.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return {
    ...actual,
    requireCapability: vi.fn(),
  }
})

import { skatteverketExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { ExtensionContext } from '@/lib/extensions/types'

const GATED: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/authorize' },
  { method: 'POST', path: '/declaration/validate' },
  { method: 'POST', path: '/declaration/draft' },
  { method: 'PUT', path: '/declaration/lock' },
  { method: 'POST', path: '/agi/submit' },
  { method: 'POST', path: '/agi/spara' },
  { method: 'POST', path: '/agi/las' },
  { method: 'POST', path: '/agi/kontrollera/hu' },
  { method: 'POST', path: '/agi/kontrollera/iu' },
  { method: 'POST', path: '/skattekonto/sync' },
]

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: vi.fn() } as any,
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

describe('skatteverket paywall gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(GATED)('$method $path returns 403 capability_blocked when not entitled', async ({ method, path }) => {
    vi.mocked(requireCapability).mockResolvedValue(
      capabilityBlockedResponse(CAPABILITY.skatteverket),
    )
    const route = skatteverketExtension.apiRoutes?.find(
      (r) => r.method === method && r.path === path,
    )
    expect(route, `${method} ${path} must be registered`).toBeDefined()

    const request = new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    })
    const response = await route!.handler(request, makeContext())

    expect(response.status).toBe(403)
    const body = (await response.json()) as { capability_blocked?: boolean; capability?: string }
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe(CAPABILITY.skatteverket)
  })

  // Unlock operations stay free: a lapsed company must be able to unlock
  // what it locked while entitled (draft recovery, never data hostage).
  it.each([
    { method: 'DELETE', path: '/declaration/lock' },
    { method: 'POST', path: '/agi/lasUpp' },
  ])('$method $path (unlock) is NOT paywall-gated', async ({ method, path }) => {
    vi.mocked(requireCapability).mockResolvedValue(
      capabilityBlockedResponse(CAPABILITY.skatteverket),
    )
    const route = skatteverketExtension.apiRoutes?.find(
      (r) => r.method === method && r.path === path,
    )
    expect(route).toBeDefined()

    const request = new Request(
      `https://test.local/api/extensions/ext/skatteverket${path}?period=202606`,
      { method },
    )
    const response = await route!.handler(request, makeContext())
    // Fails later (missing params / no tokens) but never with the paywall 403.
    if (response.status === 403) {
      const body = (await response.json()) as { capability_blocked?: boolean }
      expect(body.capability_blocked).not.toBe(true)
    }
    expect(vi.mocked(requireCapability)).not.toHaveBeenCalled()
  })
})
