import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { Notice } from '@/lib/notices/types'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const getCompanyNoticesMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/notices', () => ({
  getCompanyNotices: getCompanyNoticesMock,
}))

import { GET } from '../route'

const notice: Notice = {
  id: 'skv_disconnected:needs_reconsent@2026-08-18T03:00:00Z',
  category: 'skv_disconnected',
  severity: 'error',
  messageKey: 'skv_disconnected',
  actionKey: 'skv_disconnected_action',
  actionHref: '/settings/tax',
}

describe('GET /api/notices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    getCompanyNoticesMock.mockResolvedValue([notice])
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/notices'), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
    expect(getCompanyNoticesMock).not.toHaveBeenCalled()
  })

  it('returns the ordered notices for the active company and calling user', async () => {
    const { status, body } = await parseJsonResponse<{ data: { notices: Notice[] } }>(
      await GET(createMockRequest('/api/notices'), { params: Promise.resolve({}) }),
    )
    expect(status).toBe(200)
    expect(body.data.notices).toEqual([notice])
    expect(getCompanyNoticesMock).toHaveBeenCalledWith(supabase, 'company-1', {
      userId: 'user-1',
    })
  })
})
