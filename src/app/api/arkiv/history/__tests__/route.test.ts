import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/arkiv/history', () => ({ listArchiveHistory: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { listArchiveHistory } from '@/lib/arkiv/history'

const call = () => GET(new Request('http://localhost/api/arkiv/history'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/history', () => {
  it('answers 401 without a session', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(listArchiveHistory).not.toHaveBeenCalled()
  })

  it('lists the company history through the service role, for every company', async () => {
    delete process.env.ARKIV_BRAIN_COMPANY_IDS
    ;(listArchiveHistory as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'audit:1', at: '2026-09-22T13:31:00Z', kind: 'ingested', actor: { kind: 'user', label: 'Jakob' }, document: { id: 'd1', file_name: 'a.pdf' }, detail: null }])
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: { events: [expect.objectContaining({ kind: 'ingested' })] } })
    expect(listArchiveHistory).toHaveBeenCalledWith({ tag: 'service' }, 'company-1', 200)
  })

  it('is 500 with a message when the read fails', async () => {
    ;(listArchiveHistory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('history read failed: boom'))
    expect((await parseJsonResponse(await call())).status).toBe(500)
  })
})
