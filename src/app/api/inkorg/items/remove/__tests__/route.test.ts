import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { MAX_INBOX_ITEMS_PER_REMOVAL, type InboxItemRemovalResult } from '@/lib/inkorg/remove-items'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const deleteItemsMock = vi.fn()
vi.mock('@/lib/documents/inbox-item-actions', () => ({
  deleteInboxItems: (...args: unknown[]) => deleteItemsMock(...args),
}))

import { POST } from '../route'

const id = (n: number) => `6f1c2a40-0000-4000-8000-${String(n).padStart(12, '0')}`
const emptyParams = createMockRouteParams({})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  deleteItemsMock.mockImplementation(async (_ctx: unknown, ids: string[]) => ids.map((itemId) => ({ id: itemId, removed: true })))
})

const post = (body: unknown) => POST(createMockRequest('/api/inkorg/items/remove', { method: 'POST', body }), emptyParams)

interface Answer {
  data: { results: InboxItemRemovalResult[]; removed: number; refused: number }
}

describe('POST /api/inkorg/items/remove', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ inbox_item_ids: [id(1)] })).status).toBe(401)
    expect(deleteItemsMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post({ inbox_item_ids: [id(1)] })).status).toBe(403)
    expect(deleteItemsMock).not.toHaveBeenCalled()
  })

  it('returns 400 for no list, an empty list, an id that is not a uuid, and more ids than one request takes', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ inbox_item_ids: [] })).status).toBe(400)
    expect((await post({ inbox_item_ids: ['not-a-uuid'] })).status).toBe(400)
    const tooMany = Array.from({ length: MAX_INBOX_ITEMS_PER_REMOVAL + 1 }, (_, n) => id(n))
    expect((await post({ inbox_item_ids: tooMany })).status).toBe(400)
    expect(deleteItemsMock).not.toHaveBeenCalled()
  })

  it('takes exactly as many ids as the bound', async () => {
    const full = Array.from({ length: MAX_INBOX_ITEMS_PER_REMOVAL }, (_, n) => id(n))
    const { status, body } = await parseJsonResponse<Answer>(await post({ inbox_item_ids: full }))
    expect(status).toBe(200)
    expect(body.data.removed).toBe(MAX_INBOX_ITEMS_PER_REMOVAL)
  })

  it('removes in the active company as the signed-in person', async () => {
    await post({ inbox_item_ids: [id(1), id(2)] })
    expect(deleteItemsMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), [id(1), id(2)])
  })

  it('answers 200 with each item\'s own outcome when some are refused, with the single removal\'s words', async () => {
    deleteItemsMock.mockResolvedValue([
      { id: id(1), removed: true },
      { id: id(2), removed: false, code: 'INBOX_ITEM_DELETE_BOOKED' },
      { id: id(3), removed: false, code: 'INBOX_ITEM_DELETE_CONVERTED' },
      { id: id(4), removed: false, code: 'INBOX_ITEM_NOT_FOUND' },
      { id: id(5), removed: false, code: 'UNKNOWN_ERROR' },
    ])
    const { status, body } = await parseJsonResponse<Answer>(await post({ inbox_item_ids: [id(1), id(2), id(3), id(4), id(5)] }))
    expect(status).toBe(200)
    expect(body.data.removed).toBe(1)
    expect(body.data.refused).toBe(4)
    expect(body.data.results).toEqual([
      { id: id(1), removed: true },
      { id: id(2), removed: false, code: 'INBOX_ITEM_DELETE_BOOKED', message: 'Posten är bokförd och kan inte tas bort.', message_en: 'The inbox item is booked and cannot be deleted.' },
      {
        id: id(3),
        removed: false,
        code: 'INBOX_ITEM_DELETE_CONVERTED',
        message: 'Posten är kopplad till en leverantörsfaktura och kan inte tas bort.',
        message_en: 'The inbox item is linked to a supplier invoice and cannot be deleted.',
      },
      { id: id(4), removed: false, code: 'INBOX_ITEM_NOT_FOUND', message: 'Inkorgsposten hittades inte.', message_en: 'Inbox item not found.' },
      { id: id(5), removed: false, code: 'UNKNOWN_ERROR', message: 'Något gick fel. Försök igen.', message_en: 'An unexpected error occurred.' },
    ])
  })

  it('answers 200 when every item is refused', async () => {
    deleteItemsMock.mockResolvedValue([{ id: id(1), removed: false, code: 'INBOX_ITEM_NOT_FOUND' }])
    const { status, body } = await parseJsonResponse<Answer>(await post({ inbox_item_ids: [id(1)] }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ removed: 0, refused: 1 })
  })
})
