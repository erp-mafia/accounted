/**
 * GET /api/wiki/records/[kind]/[id]: one wiki record page. Runs through the
 * real withRouteContext wrapper with auth, the company and the loader mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const loadWikiRecordMock = vi.fn()
vi.mock('@/lib/agent-context/wiki-load', () => ({
  loadWikiRecord: (...args: unknown[]) => loadWikiRecordMock(...args),
}))

import { GET } from '../route'

const ID = '11111111-2222-4333-8444-555555555555'
const call = (kind: string, id: string) =>
  GET(createMockRequest(`/api/wiki/records/${kind}/${id}`), { params: Promise.resolve({ kind, id }) })

describe('GET /api/wiki/records/[kind]/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue('company-1')
    loadWikiRecordMock.mockResolvedValue({
      status: 'ok',
      record: { kind: 'journal_entry', id: ID, record_ref: `journal_entry:${ID}`, title: 'A1', fields: [], links: [], maintainer: null, links_unavailable: false, native_href: null },
      text: '{}',
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await parseJsonResponse(await call('journal_entry', ID))).status).toBe(401)
    expect(loadWikiRecordMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a kind the wiki does not open', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('invoice', ID))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(loadWikiRecordMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a uuid', async () => {
    expect((await parseJsonResponse(await call('document', 'not-a-uuid'))).status).toBe(400)
    expect(loadWikiRecordMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the record is not in the company', async () => {
    loadWikiRecordMock.mockResolvedValue({ status: 'not_found' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('document', ID))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 404 with ARKIV_NOT_ENABLED for a brain kind outside the rollout', async () => {
    loadWikiRecordMock.mockResolvedValue({ status: 'not_enabled' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('agreement', ID))
    expect(status).toBe(404)
    expect(body.error.code).toBe('ARKIV_NOT_ENABLED')
  })

  it('returns 404 when the agent tools are not installed', async () => {
    loadWikiRecordMock.mockResolvedValue({ status: 'unavailable' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('document', ID))
    expect(status).toBe(404)
    expect(body.error.code).toBe('AGENT_CONTEXT_UNAVAILABLE')
  })

  it('returns the record for the active company and user', async () => {
    const { status, body } = await parseJsonResponse<{ data: { record: { title: string }; text: string } }>(await call('journal_entry', ID))
    expect(status).toBe(200)
    expect(body.data.record.title).toBe('A1')
    expect(body.data.text).toBe('{}')
    expect(loadWikiRecordMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'journal_entry', ID)
  })
})
