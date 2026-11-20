import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Originals are signed with the service-role client, like GET /api/documents/:id.
const createSignedUrlMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ storage: { from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })) } }),
}))

import { GET } from '../route'

const DOC = '33333333-3333-4333-8333-333333333333'
const FIRST_VERSION = '55555555-5555-4555-8555-555555555555'
const ARRIVAL = '22222222-2222-4222-8222-222222222222'
const ITEM = '44444444-4444-4444-8444-444444444444'

function req(id = DOC) {
  return [new Request(`http://localhost/api/documents/${id}/arrivals`), createMockRouteParams({ id })] as const
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed-eml' }, error: null })
})

describe('GET /api/documents/[id]/arrivals', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await GET(...req()))
    expect(status).toBe(401)
  })

  it('returns 400 for an id that is not a UUID', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await GET(...req('doc-1')))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it("returns 404 when the document is not in the company", async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await GET(...req()))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(findCalls('document_attachments', 'eq')).toEqual([
      ['id', DOC],
      ['company_id', 'company-1'],
    ])
  })

  it('returns the arrivals behind the document with a signed original, including those of its first version', async () => {
    enqueue({ data: { id: DOC, original_id: FIRST_VERSION } })
    enqueue({ data: [{ arrival_id: ARRIVAL }] })
    enqueue({
      data: [
        {
          id: ARRIVAL,
          company_id: 'company-1',
          source: 'intake_email',
          source_ref: 'em_1',
          received_at: '2026-10-15T08:00:00Z',
          sender: { from: 'faktura@leverantor.example', to: ['acme@inbox.example'] },
          subject: 'Faktura 1001',
          message_text: 'Hej!',
          original_path: `documents/company-1/arrivals/${ARRIVAL}/em_1.eml`,
          original_sha256: 'a'.repeat(64),
          original_mime: 'message/rfc822',
          original_size: 4096,
          fetched_by: { type: 'webhook', label: 'resend-inbound' },
          source_meta: { headers: {} },
          created_at: '2026-10-15T08:00:01Z',
        },
      ],
    })
    enqueue({
      data: [
        { arrival_id: ARRIVAL, output_kind: 'document', output_id: FIRST_VERSION, role: 'attachment', position: 0 },
        { arrival_id: ARRIVAL, output_kind: 'inbox_item', output_id: ITEM, role: 'attachment', position: 0 },
      ],
    })

    const res = await GET(...req())
    // Signed URLs and sender addresses: never kept by a cache.
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const { status, body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([
      {
        id: ARRIVAL,
        source: 'intake_email',
        received_at: '2026-10-15T08:00:00Z',
        sender: { from: 'faktura@leverantor.example', to: ['acme@inbox.example'] },
        subject: 'Faktura 1001',
        message_text: 'Hej!',
        fetched_by: { type: 'webhook', label: 'resend-inbound' },
        has_original: true,
        original_mime: 'message/rfc822',
        original_size: 4096,
        original_file_name: 'em_1.eml',
        original_url: 'https://storage.example/signed-eml',
        outputs: [
          { kind: 'document', id: FIRST_VERSION, role: 'attachment' },
          { kind: 'inbox_item', id: ITEM, role: 'attachment' },
        ],
      },
    ])
    // Both versions were asked for, scoped to the company.
    expect(findCalls('arrival_outputs', 'in')[0]).toEqual(['output_id', [DOC, FIRST_VERSION]])
    expect(findCalls('arrival_outputs', 'eq')[0]).toEqual(['company_id', 'company-1'])
    expect(createSignedUrlMock).toHaveBeenCalledWith(`documents/company-1/arrivals/${ARRIVAL}/em_1.eml`, 300, { download: 'em_1.eml' })
  })

  it('returns an empty list for a document with no recorded arrival', async () => {
    enqueue({ data: { id: DOC, original_id: null } })
    enqueue({ data: [] })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(await GET(...req()))
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(createSignedUrlMock).not.toHaveBeenCalled()
  })
})
