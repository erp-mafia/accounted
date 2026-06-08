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

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

function makeReq() {
  return new Request('http://localhost/api/documents/inbox-available')
}

describe('GET /api/documents/inbox-available', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeReq(), createMockRouteParams({}))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns [] when no eligible inbox items (no second query)', async () => {
    enqueue({ data: [] }) // inbox items
    const res = await GET(makeReq(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    // Documents table never queried when there are no document ids.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('joins inbox items to their documents and drops consumed/superseded ones', async () => {
    enqueue({
      data: [
        {
          id: 'inbox-1',
          document_id: 'doc-1',
          source: 'email',
          created_at: '2026-05-01T00:00:00Z',
          extracted_data: {
            supplier: { name: 'Acme AB' },
            totals: { total: 1250 },
            invoice: { currency: 'SEK', invoiceDate: '2026-04-28' },
          },
        },
        // doc-2's document is no longer current/unlinked → must be dropped.
        {
          id: 'inbox-2',
          document_id: 'doc-2',
          source: 'upload',
          created_at: '2026-05-02T00:00:00Z',
          extracted_data: null,
        },
      ],
    })
    enqueue({
      data: [
        {
          id: 'doc-1',
          file_name: 'acme.pdf',
          mime_type: 'application/pdf',
          file_size_bytes: 1000,
          journal_entry_id: null,
          is_current_version: true,
        },
      ],
    })

    const res = await GET(makeReq(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{
      data: Array<Record<string, unknown>>
    }>(res)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toEqual({
      inbox_item_id: 'inbox-1',
      document_id: 'doc-1',
      file_name: 'acme.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 1000,
      source: 'email',
      created_at: '2026-05-01T00:00:00Z',
      supplier_name: 'Acme AB',
      amount: 1250,
      currency: 'SEK',
      invoice_date: '2026-04-28',
    })
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('returns an error envelope when the inbox query fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const res = await GET(makeReq(), createMockRouteParams({}))
    const { status } = await parseJsonResponse(res)
    expect(status).toBeGreaterThanOrEqual(500)
  })
})
