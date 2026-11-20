import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { ACCEPTED_DOCUMENTS, LEGAL_DOCUMENTS } from '@/lib/legal/documents'

const user = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: () => requireAuthMock() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))

import { POST } from '../route'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const documents = () => ACCEPTED_DOCUMENTS.map((key) => ({ key, version: LEGAL_DOCUMENTS[key].acceptanceVersion }))
const req = (body: unknown) => createMockRequest('/api/legal/accept', { method: 'POST', body })

beforeEach(() => {
  vi.clearAllMocks()
  user.reset()
  service.reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: user.supabase, error: null })
})

describe('POST /api/legal/accept', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await POST(req({ documents: documents(), method: 'accept_all', analytics_consent: true }))).status).toBe(401)
  })

  it('400 on an invalid body, and on "accept all" with a choice switched off', async () => {
    expect((await POST(req({ documents: [], method: 'accept_all', analytics_consent: true }))).status).toBe(400)
    expect((await POST(req({ documents: documents(), method: 'clicked', analytics_consent: true }))).status).toBe(400)
    expect((await POST(req({ documents: documents(), method: 'accept_all', analytics_consent: false }))).status).toBe(400)
    expect((await POST(req({ documents: [{ key: 'cookies', version: '2026-10-21' }, ...documents()], method: 'accept_documents', analytics_consent: false }))).status).toBe(400)
  })

  it('409 when a document version is stale or missing: the person must read the new one first', async () => {
    const stale = documents().map((d) => (d.key === 'dpa' ? { ...d, version: '2020-01-01' } : d))
    const res = await POST(req({ documents: stale, method: 'accept_documents', analytics_consent: false }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(user.findCall('legal_acceptances', 'upsert')).toBeUndefined()
  })

  it('404 for a company the person is not a member of', async () => {
    user.enqueue({ data: null })
    const res = await POST(req({ documents: documents(), method: 'accept_documents', analytics_consent: false, company_id: COMPANY }))
    expect(res.status).toBe(404)
  })

  it('403 when a member who is not an owner or admin turns content contribution on', async () => {
    user.enqueue({ data: { role: 'member' } })
    const res = await POST(req({ documents: documents(), method: 'accept_documents', analytics_consent: false, company_id: COMPANY, content_contribution: true }))
    expect(res.status).toBe(403)
    expect(user.findCall('legal_acceptances', 'upsert')).toBeUndefined()
  })

  it('records the documents and the analytics choice, without a company', async () => {
    user.enqueue({ data: null }) // legal_acceptances upsert
    user.enqueue({ data: null }) // user_preferences upsert
    const res = await POST(req({ documents: documents(), method: 'accept_documents', analytics_consent: false }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ accepted: ACCEPTED_DOCUMENTS, analytics_consent: false, content_contribution: null })
    const rows = user.findCalls('legal_acceptances', 'upsert').map(([row]) => row)
    expect(rows).toEqual(
      ACCEPTED_DOCUMENTS.map((key) => ({ user_id: 'user-1', company_id: null, document_key: key, version: LEGAL_DOCUMENTS[key].acceptanceVersion, method: 'accept_documents' })),
    )
    expect(user.findCall('user_preferences', 'upsert')?.[0]).toMatchObject({ user_id: 'user-1', analytics_consent: false })
    expect(service.supabase.rpc).not.toHaveBeenCalled()
  })

  it('"accept all" by an owner: documents, analytics and the company\'s content contribution', async () => {
    user.enqueue({ data: { role: 'owner' } })
    user.enqueue({ data: null })
    user.enqueue({ data: null })
    service.enqueue({ data: { ok: true, unchanged: false, enabled: true } })
    const res = await POST(req({ documents: documents(), method: 'accept_all', analytics_consent: true, company_id: COMPANY, content_contribution: true }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ analytics_consent: true, content_contribution: true })
    expect(user.findCall('legal_acceptances', 'upsert')?.[0]).toMatchObject({ company_id: COMPANY, method: 'accept_all' })
    expect(service.supabase.rpc).toHaveBeenCalledWith('set_company_data_choice', expect.objectContaining({ p_company_id: COMPANY, p_key: 'data:contribution', p_enabled: true, p_decided_by: 'user-1' }))
  })
})
