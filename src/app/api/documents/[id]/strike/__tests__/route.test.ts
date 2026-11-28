/**
 * Tests for POST and GET /api/documents/[id]/strike: strike the link of an
 * underlag attached to the wrong verifikat and give the right one a copy
 * (lib/documents/strike-link.ts, mocked here: its rules are its own tests and
 * the database's are tests/pg/document-link-strike.pg.test.ts).
 *
 * Covers: 401, 400 on a missing reason or a malformed verifikat id, 404 for a
 * path id that is no uuid and for a document the company does not have, the
 * refusals as 409 with their code, 500 on a failure, the happy path, and the
 * read of a strike with who made it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createTableMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const DOC = '07d97135-5e40-5982-b76e-60a9095f9139'
const RIGHT = '33333333-3333-4333-8333-333333333333'
const COPY = '44444444-4444-4444-8444-444444444444'

const { supabase, setTable, reset } = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const strikeDocumentLink = vi.fn()
vi.mock('@/lib/documents/strike-link', () => ({
  strikeDocumentLink: (...args: unknown[]) => strikeDocumentLink(...args),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({ service: true })),
}))
const resolveUserLabelsFromProfiles = vi.fn()
vi.mock('@/lib/reports/behandlingshistorik', () => ({
  resolveUserLabelsFromProfiles: (...args: unknown[]) => resolveUserLabelsFromProfiles(...args),
}))

import { GET, POST } from '../route'

const params = (id = DOC) => createMockRouteParams({ id })
const post = (body: unknown, id = DOC) =>
  POST(createMockRequest(`/api/documents/${id}/strike`, { method: 'POST', body }), params(id))

describe('POST /api/documents/[id]/strike', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const response = await post({ journal_entry_id: RIGHT, reason: 'fel verifikat' })
    expect(response.status).toBe(401)
    expect(strikeDocumentLink).not.toHaveBeenCalled()
  })

  it('returns 400 without a reason or with a malformed verifikat id', async () => {
    expect((await post({ journal_entry_id: RIGHT, reason: '   ' })).status).toBe(400)
    expect((await post({ journal_entry_id: 'A12', reason: 'fel verifikat' })).status).toBe(400)
    expect((await post({ journal_entry_id: RIGHT, reason: 'x'.repeat(501) })).status).toBe(400)
    expect(strikeDocumentLink).not.toHaveBeenCalled()
  })

  it('returns 404 for a path id that is no uuid, and for a document the company does not have', async () => {
    expect((await post({ journal_entry_id: RIGHT, reason: 'fel' }, 'not-a-uuid')).status).toBe(404)
    strikeDocumentLink.mockResolvedValue({ ok: false, code: 'NOT_FOUND', resource: 'document' })
    const response = await post({ journal_entry_id: RIGHT, reason: 'fel' })
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('DOC_NOT_FOUND')
  })

  it('answers a refusal with its code', async () => {
    strikeDocumentLink.mockResolvedValue({ ok: false, code: 'DOC_STRIKE_PINNED_TRANSACTION' })
    const response = await post({ journal_entry_id: RIGHT, reason: 'fel verifikat' })
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('DOC_STRIKE_PINNED_TRANSACTION')
    expect(body.error.message).toContain('banktransaktionens')
  })

  it('returns 500 when the strike fails', async () => {
    strikeDocumentLink.mockRejectedValue(new Error('connection reset'))
    const response = await post({ journal_entry_id: RIGHT, reason: 'fel verifikat' })
    expect(response.status).toBe(500)
  })

  it('strikes the link as the session user and answers the struck row and the copy', async () => {
    const document = { id: DOC, journal_entry_id: 'je-wrong', link_struck_at: '2026-11-27T10:00:00Z', link_struck_by: 'user-1', link_struck_reason: 'Hör till A12', link_struck_copy_id: COPY }
    strikeDocumentLink.mockResolvedValue({ ok: true, document, copy: { id: COPY, journal_entry_id: RIGHT, reused: false } })

    const response = await post({ journal_entry_id: RIGHT, reason: '  Hör till A12 ' })
    const { body } = await parseJsonResponse<{ data: { document: unknown; copy: unknown } }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ document, copy: { id: COPY, journal_entry_id: RIGHT, reused: false } })
    expect(strikeDocumentLink).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      document_id: DOC,
      journal_entry_id: RIGHT,
      reason: 'Hör till A12',
    })
  })
})

describe('GET /api/documents/[id]/strike', () => {
  const get = () => GET(createMockRequest(`/api/documents/${DOC}/strike`), params())

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
  })

  it('returns 404 for a document the company does not have', async () => {
    setTable('document_attachments', { data: null })
    expect((await get()).status).toBe(404)
  })

  it('answers null for a link that is not struck', async () => {
    setTable('document_attachments', {
      data: { id: DOC, link_struck_at: null, link_struck_by: null, link_struck_reason: null, link_struck_copy_id: null },
    })
    const { body } = await parseJsonResponse<{ data: unknown }>(await get())
    expect(body.data).toBeNull()
  })

  it('says who struck the link, when, why, and which verifikat got the copy', async () => {
    setTable('document_attachments', [
      { data: { id: DOC, link_struck_at: '2026-11-27T10:00:00Z', link_struck_by: 'user-2', link_struck_reason: 'Hör till A12', link_struck_copy_id: COPY } },
      { data: { id: COPY, journal_entry_id: RIGHT } },
    ])
    setTable('journal_entries', { data: { id: RIGHT, voucher_series: 'A', voucher_number: 12 } })
    resolveUserLabelsFromProfiles.mockResolvedValue(new Map([['user-2', 'anna@example.se']]))

    const response = await get()
    const { body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      struck_at: '2026-11-27T10:00:00Z',
      struck_by: 'user-2',
      struck_by_label: 'anna@example.se',
      reason: 'Hör till A12',
      copy: { document_id: COPY, journal_entry_id: RIGHT, voucher_series: 'A', voucher_number: 12 },
    })
    expect(resolveUserLabelsFromProfiles).toHaveBeenCalledWith({ service: true }, ['user-2'], 'company-1')
  })
})
