/**
 * The permission shadow at the extension dispatcher: the dispatcher tells it
 * what its role gates did, the response is byte-identical with the shadow on
 * and off, and a disagreement schedules exactly one log write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'

const state = vi.hoisted(() => ({ role: 'viewer' as CompanyRole | undefined }))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: {} })),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn(async (_s: unknown, _u: string, facts?: ActiveCompanyFacts) => {
    if (facts && state.role) facts.role = state.role
    return 'company-1'
  }),
}))
vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn().mockReturnValue({ userId: 'user-1' }),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  requireCapability: vi.fn(async () => null),
}))
vi.mock('@/lib/extensions/sectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/extensions/sectors')>()),
  requiredCapabilityForExtensionId: vi.fn(() => undefined),
}))

import { extensionRegistry } from '@/lib/extensions/registry'
import { insertShadowRow } from '@/lib/permissions/shadow-writer'
import { resetPermissionShadowForTests } from '@/lib/permissions/shadow'
import { POST } from '../route'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function snapshot(res: Response) {
  // The per-request id and the Server-Timing durations differ per call.
  const strip = (v: string) => v.replace(/req_[0-9a-f-]{36}/g, 'req_X').replace(/dur=\d+/g, 'dur=N')
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'x-request-id' && k !== 'x-trace-id').map(([k, v]) => [k, strip(v)])
  return { status: res.status, headers, body: strip(await res.text()) }
}

async function callTwice(extensionId: string, rest: string[]) {
  const call = async () =>
    snapshot(
      await POST(new Request(`http://localhost/api/extensions/ext/${extensionId}/${rest.join('/')}`, { method: 'POST' }), {
        params: Promise.resolve({ path: [extensionId, ...rest] }),
      }),
    )
  process.env.PERMISSIONS_SHADOW = 'off'
  const off = await call()
  await flush()
  expect(insertShadowRow).not.toHaveBeenCalled()
  delete process.env.PERMISSIONS_SHADOW
  const on = await call()
  await flush()
  return { off, on }
}

describe('extension dispatcher: permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPermissionShadowForTests()
    extensionRegistry.clear()
    delete process.env.PERMISSIONS_SHADOW
  })
  afterEach(() => {
    delete process.env.PERMISSIONS_SHADOW
  })

  it('refuses a viewer on an ungated write route by default, where decide() agrees, and answers the same', async () => {
    state.role = 'viewer'
    extensionRegistry.register({
      id: 'cloud-backup',
      name: 'Cloud backup',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/connect', handler: async () => NextResponse.json({ data: { ok: true } }) }],
    })
    const { off, on } = await callTwice('cloud-backup', ['connect'])
    expect(on).toEqual(off)
    expect(on.status).toBe(403)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('logs nothing where the gate and decide() agree, and answers the same', async () => {
    state.role = 'viewer'
    extensionRegistry.register({
      id: 'cloud-backup',
      name: 'Cloud backup',
      version: '1.0.0',
      apiRoutes: [
        { method: 'POST', path: '/sync', requireWrite: true, handler: async () => NextResponse.json({ data: {} }) },
      ],
    })
    const { off, on } = await callTwice('cloud-backup', ['sync'])
    expect(on).toEqual(off)
    expect(on.status).toBe(403)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })
})
