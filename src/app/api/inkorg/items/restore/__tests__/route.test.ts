import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const restoreMock = vi.fn()
vi.mock('@/lib/operations/inbox-restore', () => ({
  restoreInboxItem: (...args: unknown[]) => restoreMock(...args),
}))

import { POST } from '../route'

const ITEM_ID = '6f1c2a40-0000-4000-8000-0000000000a1'
const DOC_ID = '6f1c2a40-0000-4000-8000-0000000000d1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  restoreMock.mockResolvedValue({ ok: true, data: { id: ITEM_ID, document_id: DOC_ID, restored: true } })
})

const post = (body: unknown = { inbox_item_id: ITEM_ID }) =>
  POST(createMockRequest('/api/inkorg/items/restore', { method: 'POST', body }), createMockRouteParams({}))

describe('POST /api/inkorg/items/restore', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post()).status).toBe(401)
    expect(restoreMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer, as the removal does', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post()).status).toBe(403)
    expect(restoreMock).not.toHaveBeenCalled()
  })

  it('returns 400 without an item id, or with one that is not a uuid', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ inbox_item_id: 'not-a-uuid' })).status).toBe(400)
    expect(restoreMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the company has no deleted item under that id', async () => {
    restoreMock.mockResolvedValue({ ok: false, code: 'INBOX_ITEM_RESTORE_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_RESTORE_NOT_FOUND')
    expect(body.error.message).toBe('Det finns ingen borttagen post att lägga tillbaka.')
  })

  it.each([
    ['INBOX_ITEM_RESTORE_IN_INBOX', undefined, 'Dokumentet ligger redan i inkorgen.'],
    ['INBOX_ITEM_RESTORE_BOOKED', { journal_entry_id: 'je-1' }, 'Dokumentet sitter på en verifikation och kan inte läggas tillbaka i inkorgen.'],
    [
      'INBOX_ITEM_RESTORE_LINKED',
      { linked_to: 'bank_transaction' },
      'Dokumentet är underlag till en leverantörsfaktura, ett utlägg eller en banktransaktion och kan inte läggas tillbaka i inkorgen.',
    ],
    ['INBOX_ITEM_RESTORE_DUPLICATE', undefined, 'En kopia av samma fil ligger redan i inkorgen eller är redan bokförd. Posten lades inte tillbaka.'],
  ])('returns 409 %s with a sentence that says why', async (code, details, message) => {
    restoreMock.mockResolvedValue({ ok: false, code, details })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string; details?: unknown } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe(code)
    expect(body.error.message).toBe(message)
    expect(body.error.message_en).toBeTruthy()
    if (details) expect(body.error.details).toEqual(details)
  })

  it('puts the item back in the active company, as the signed-in person', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await post())
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: ITEM_ID, document_id: DOC_ID, restored: true })
    expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), ITEM_ID)
  })
})
