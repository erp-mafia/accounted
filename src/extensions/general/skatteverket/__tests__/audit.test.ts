import { beforeEach, describe, expect, it, vi } from 'vitest'

const createServiceClientMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
}))

import { writeSkatteverketAudit } from '../lib/audit'

describe('writeSkatteverketAudit', () => {
  const insert = vi.fn()
  const from = vi.fn(() => ({ insert }))
  const userFrom = vi.fn()
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    insert.mockResolvedValue({ error: null })
    createServiceClientMock.mockReturnValue({ from })
  })

  it('writes through the service-role client while preserving tenant metadata', async () => {
    await writeSkatteverketAudit(
      {
        companyId: 'company-1',
        userId: 'user-1',
        supabase: { from: userFrom },
        log,
      } as never,
      {
        endpoint: '/momsdeklarationer',
        outcome: 'ok',
        responseStatus: 200,
        correlationId: 'corr-1',
      },
    )

    expect(createServiceClientMock).toHaveBeenCalledOnce()
    expect(userFrom).not.toHaveBeenCalled()
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
    expect(log.error).not.toHaveBeenCalled()
  })

  it('keeps the primary regulator flow alive and logs insert failures with correlation data', async () => {
    insert.mockResolvedValue({ error: { message: 'database unavailable' } })

    await writeSkatteverketAudit(
      {
        companyId: 'company-1',
        userId: 'user-1',
        supabase: { from: userFrom },
        log,
      } as never,
      {
        endpoint: '/momsdeklarationer',
        outcome: 'internal_error',
        correlationId: 'corr-2',
      },
    )

    expect(log.error).toHaveBeenCalledWith(
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
