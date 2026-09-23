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

  it('records a successful lock before persisting the signing state', async () => {
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
    expect(mockWriteSkatteverketAudit).toHaveBeenCalledWith(ctx, {
      endpoint: 'declaration/lock',
      agRegistreradId: '165560000000',
      redovisningsperiod: '202606',
      outcome: 'ok',
      responseStatus: 200,
    })
    expect(ctx.settings.set).toHaveBeenCalledWith(
      'submission_202606',
      expect.stringContaining('"status":"draft_locked"'),
    )
    expect(mockWriteSkatteverketAudit.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.settings.set).mock.invocationCallOrder[0]!,
    )
  })

  it('records a rejected lock response', async () => {
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
    expect(mockWriteSkatteverketAudit).toHaveBeenCalledWith(ctx, {
      endpoint: 'declaration/lock',
      agRegistreradId: '165560000000',
      redovisningsperiod: '202606',
      outcome: 'skv_error',
      responseStatus: 409,
    })
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })
})
