import { beforeEach, describe, expect, it, vi } from 'vitest'

const createServiceClientMock = vi.fn()
const logError = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError, child: vi.fn() }),
}))

import { auditUserIdFor, writeSkatteverketAudit } from '../lib/audit'

describe('writeSkatteverketAudit', () => {
  const insert = vi.fn()
  const from = vi.fn(() => ({ insert }))

  beforeEach(() => {
    vi.clearAllMocks()
    insert.mockResolvedValue({ error: null })
    createServiceClientMock.mockReturnValue({ from })
  })

  it('writes through the service-role client while preserving tenant metadata', async () => {
    await writeSkatteverketAudit(
      { companyId: 'company-1', userId: 'user-1' },
      {
        endpoint: '/momsdeklarationer',
        outcome: 'ok',
        responseStatus: 200,
        correlationId: 'corr-1',
      },
    )

    expect(createServiceClientMock).toHaveBeenCalledOnce()
    expect(from).toHaveBeenCalledWith('skatteverket_api_audit_log')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'company-1',
        user_id: 'user-1',
        endpoint: '/momsdeklarationer',
        outcome: 'ok',
        correlation_id: 'corr-1',
      }),
    )
    expect(logError).not.toHaveBeenCalled()
  })

  it('records a call the system made with no user as a null user_id', async () => {
    await writeSkatteverketAudit(
      { companyId: 'company-1', userId: null },
      { endpoint: 'kvittenser', outcome: 'ok', responseStatus: 200 },
    )

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'company-1', user_id: null, endpoint: 'kvittenser' }),
    )
  })

  it('keeps the primary regulator flow alive and logs insert failures with correlation data', async () => {
    insert.mockResolvedValue({ error: { message: 'database unavailable' } })

    await writeSkatteverketAudit(
      { companyId: 'company-1', userId: 'user-1' },
      {
        endpoint: '/momsdeklarationer',
        outcome: 'internal_error',
        correlationId: 'corr-2',
      },
    )

    expect(logError).toHaveBeenCalledWith(
      'skatteverket_api_audit_log insert failed',
      expect.objectContaining({
        endpoint: '/momsdeklarationer',
        outcome: 'internal_error',
        correlationId: 'corr-2',
        error: 'database unavailable',
      }),
    )
  })
})

describe('auditUserIdFor', () => {
  it('names the personal token owner, and no one for system credentials', () => {
    expect(
      auditUserIdFor({ mode: 'user', supabase: {} as never, userId: 'owner-1', companyId: 'company-1' }),
    ).toBe('owner-1')
    expect(auditUserIdFor({ mode: 'system' })).toBeNull()
  })
})
