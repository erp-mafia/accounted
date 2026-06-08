import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

import { POST } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
})

function makeReq(body: unknown) {
  return new Request('http://localhost/api/documents/doc-1/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/documents/[id]/link', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeReq({ journal_entry_id: 'je-1' }), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await POST(makeReq({ journal_entry_id: 'je-1' }), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('rejects a missing journal_entry_id', async () => {
    const res = await POST(makeReq({}), createMockRouteParams({ id: 'doc-1' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('links the document and stamps the inbox item when inbox_item_id is given', async () => {
    enqueue({ data: { id: 'je-1' } }) // journal entry company check
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1', file_name: 'x.pdf' } }) // link update
    enqueue({ data: null }) // inbox stamp update

    const res = await POST(
      makeReq({ journal_entry_id: 'je-1', inbox_item_id: 'inbox-1' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('does not touch the inbox when no inbox_item_id is given', async () => {
    enqueue({ data: { id: 'je-1' } }) // journal entry company check
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1', file_name: 'x.pdf' } }) // link update

    const res = await POST(
      makeReq({ journal_entry_id: 'je-1' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('maps a period-lock trigger error to PERIOD_LOCKED', async () => {
    enqueue({ data: { id: 'je-1' } }) // journal entry company check
    enqueue({
      data: null,
      error: { message: 'new row violates ... locked/closed fiscal period' },
    })
    const res = await POST(
      makeReq({ journal_entry_id: 'je-1', inbox_item_id: 'inbox-1' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    // The inbox stamp must not run when the link itself failed.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('maps an already-linked error to DOC_LINK_ALREADY_LINKED', async () => {
    enqueue({ data: { id: 'je-1' } }) // journal entry company check
    enqueue({
      data: null,
      error: { message: 'document already linked to another entry' },
    })
    const res = await POST(
      makeReq({ journal_entry_id: 'je-1' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('DOC_LINK_ALREADY_LINKED')
  })

  it('rejects a journal entry outside the active company with DOC_LINK_ENTRY_NOT_FOUND', async () => {
    // The company-scoped lookup finds no row — same result whether the id is
    // bogus or belongs to another tenant. The document must never be updated.
    enqueue({ data: null }) // journal entry company check → no match
    const res = await POST(
      makeReq({ journal_entry_id: 'je-other-company' }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('DOC_LINK_ENTRY_NOT_FOUND')
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })
})
