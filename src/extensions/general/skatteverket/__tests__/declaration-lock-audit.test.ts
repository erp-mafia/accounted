import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSkvRequest = vi.fn()
const mockWriteSkatteverketAudit = vi.fn()

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return {
    ...actual,
    skvRequest: (...args: unknown[]) => mockSkvRequest(...args),
  }
})

vi.mock('../lib/audit', () => ({
  writeSkatteverketAudit: (...args: unknown[]) => mockWriteSkatteverketAudit(...args),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return {
    ...actual,
    requireCapability: vi.fn().mockResolvedValue(null),
  }
})

import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req-lock-audit',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: {} as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function lockRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (candidate) => candidate.method === 'PUT' && candidate.path === '/declaration/lock',
  )
  expect(route).toBeDefined()
  return route!
}

describe('direct VAT declaration lock audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The transport writes the row inside skvRequest (transport-audit.test.ts
  // counts it); the route only names the guard-read label and writes none.
  it('labels the lock for the reset guards and persists the signing state after the call', async () => {
    mockSkvRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signeringsLank: 'https://skv.test/sign/vat' }),
    })
    const ctx = makeContext()
    const response = await lockRoute().handler(
      new Request(
        'https://test.local/api/extensions/ext/skatteverket/declaration/lock?redovisare=165560000000&redovisningsperiod=202606',
        { method: 'PUT' },
      ),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(mockSkvRequest).toHaveBeenCalledWith(
      ctx.supabase,
      'user-1',
      'company-1',
      'PUT',
      '/las/165560000000/202606',
      { endpoint: 'declaration/lock', agRegistreradId: '165560000000', redovisningsperiod: '202606' },
    )
    expect(mockWriteSkatteverketAudit).not.toHaveBeenCalled()
    expect(ctx.settings.set).toHaveBeenCalledWith(
      'submission_202606',
      expect.stringContaining('"status":"draft_locked"'),
    )
    expect(mockSkvRequest.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.settings.set).mock.invocationCallOrder[0]!,
    )
  })

  it('does not persist a rejected lock', async () => {
    mockSkvRequest.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => 'already locked',
    })
    const ctx = makeContext()
    const response = await lockRoute().handler(
      new Request(
        'https://test.local/api/extensions/ext/skatteverket/declaration/lock?redovisare=165560000000&redovisningsperiod=202606',
        { method: 'PUT' },
      ),
      ctx,
    )

    expect(response.status).toBe(409)
    expect(mockWriteSkatteverketAudit).not.toHaveBeenCalled()
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })
})
