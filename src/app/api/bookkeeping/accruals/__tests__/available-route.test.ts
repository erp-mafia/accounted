import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const readAccrualRoom = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/bookkeeping/accruals/manual', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/accruals/manual')>()),
  readAccrualRoom: (...args: unknown[]) => readAccrualRoom(...args),
}))

import { GET } from '../available/route'

const routeParams = { params: Promise.resolve({}) }
const ENTRY_ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

function request(query: string) {
  return createMockRequest(`/api/bookkeeping/accruals/available?${query}`)
}

describe('GET /api/bookkeeping/accruals/available', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const { status } = await parseJsonResponse(await GET(request('direction=expense&balance_account=1730'), routeParams))
    expect(status).toBe(401)
  })

  it('returns 400 for an account outside 17xx/29xx', async () => {
    const { status } = await parseJsonResponse(await GET(request('direction=expense&balance_account=1930'), routeParams))
    expect(status).toBe(400)
    expect(readAccrualRoom).not.toHaveBeenCalled()
  })

  it('returns 404 when the origin verifikat is missing', async () => {
    readAccrualRoom.mockResolvedValue({ ok: false, code: 'ACCRUAL_ORIGIN_NOT_FOUND' })
    const { status } = await parseJsonResponse(
      await GET(request(`direction=expense&balance_account=1730&origin_journal_entry_id=${ENTRY_ID}`), routeParams),
    )
    expect(status).toBe(404)
  })

  it('answers what remains on the account', async () => {
    const room = {
      balance_account: '1730', direction: 'expense', deferral: true,
      ledger_balance_sek: 6000, planned_sek: 0, origin_amount_sek: 12000, available_sek: 6000,
    }
    readAccrualRoom.mockResolvedValue({ ok: true, data: room })

    const { status, body } = await parseJsonResponse<{ data: typeof room }>(
      await GET(request(`direction=expense&balance_account=1730&origin_journal_entry_id=${ENTRY_ID}`), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual(room)
    expect(readAccrualRoom).toHaveBeenCalledWith(supabase, 'company-1', {
      direction: 'expense', balance_account: '1730', origin_journal_entry_id: ENTRY_ID,
    })
  })
})
