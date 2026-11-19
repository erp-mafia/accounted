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
const renderMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reminders/preview')>()),
  renderReminderPreview: renderMock,
}))

import { GET } from '../route'
import { NoInvoiceToPreviewError } from '@/lib/reminders/preview'

const get = (searchParams?: Record<string, string>) =>
  GET(createMockRequest('/api/reminders/preview', searchParams ? { searchParams } : undefined), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reminders/preview', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
  })

  it('returns 400 for a bad invoice id or level', async () => {
    expect((await get({ invoice_id: 'nope' })).status).toBe(400)
    expect((await get({ level: '4' })).status).toBe(400)
  })

  it('renders the preview for the active company', async () => {
    renderMock.mockResolvedValue({ invoiceId: 'inv-1', level: 2, subject: 'Andra påminnelsen', html: '<p/>', invoiceNumber: 'F-1', to: 'kund@example.se' })
    const res = await get({ invoice_id: '11111111-1111-4111-8111-111111111111', level: '2' })
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: { level: number } }>(res)).body.data.level).toBe(2)
    expect(renderMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ invoiceId: '11111111-1111-4111-8111-111111111111', level: 2 }))
  })

  it('answers 404 with no invoice to show it with', async () => {
    renderMock.mockRejectedValue(new NoInvoiceToPreviewError())
    expect((await get()).status).toBe(404)
  })
})
