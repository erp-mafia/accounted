import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createTableMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const ladderMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/invoice-ladder', () => ({ loadInvoiceReminderLadder: ladderMock }))

import { GET } from '../route'
import { ReminderInvoiceNotFoundError } from '@/lib/reminders/facts'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const get = (searchParams?: Record<string, string>) =>
  GET(createMockRequest('/api/reminders/ladder', searchParams ? { searchParams } : undefined), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reminders/ladder', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get({ invoice_id: INVOICE_ID })).status).toBe(401)
    expect(ladderMock).not.toHaveBeenCalled()
  })

  it('returns 400 without a valid invoice id', async () => {
    expect((await get()).status).toBe(400)
    expect((await get({ invoice_id: 'nope' })).status).toBe(400)
    expect(ladderMock).not.toHaveBeenCalled()
  })

  it("answers the invoice's place on the ladder for the active company", async () => {
    ladderMock.mockResolvedValue({ on: true, follows: false, days: [15, 30, 45] })
    const res = await get({ invoice_id: INVOICE_ID })
    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).body).toEqual({ data: { on: true, follows: false, days: [15, 30, 45] } })
    expect(ladderMock).toHaveBeenCalledWith(expect.anything(), 'company-1', INVOICE_ID, expect.objectContaining({ now: expect.any(Date) }))
  })

  it("answers 404 for an invoice that is not the company's", async () => {
    ladderMock.mockRejectedValue(new ReminderInvoiceNotFoundError())
    expect((await get({ invoice_id: INVOICE_ID })).status).toBe(404)
  })
})
