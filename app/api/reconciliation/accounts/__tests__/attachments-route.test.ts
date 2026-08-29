/**
 * Tests for the dashboard underlag routes (cookie session, withRouteContext):
 * GET/POST /api/reconciliation/accounts/{accountKey}/attachments and
 * GET/DELETE .../attachments/{attachmentId}. The policy layer is mocked; the wrapper is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const listMock = vi.fn()
const attachMock = vi.fn()
const removeMock = vi.fn()
const downloadMock = vi.fn()
vi.mock('@/lib/reconciliation/attachments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/attachments')>('@/lib/reconciliation/attachments')
  return {
    ...actual,
    listAttachments: (...args: unknown[]) => listMock(...args),
    attachUnderlag: (...args: unknown[]) => attachMock(...args),
    removeUnderlag: (...args: unknown[]) => removeMock(...args),
    downloadUnderlag: (...args: unknown[]) => downloadMock(...args),
  }
})
const getRowMock = vi.fn()
vi.mock('@/lib/reconciliation/attachments-store', () => ({
  getAttachmentRow: (...args: unknown[]) => getRowMock(...args),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ storage: { from: () => ({}) } }),
}))

import { ReconciliationAttachmentError } from '@/lib/reconciliation/attachments'
import { GET as listGET, POST as attachPOST } from '../[accountKey]/attachments/route'
import { GET as fileGET, DELETE as removeDELETE } from '../[accountKey]/attachments/[attachmentId]/route'

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111'
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) }) as never
const attachment = {
  id: ATTACHMENT_ID,
  account_key: 'manual:2350',
  through_date: '2026-12-31',
  file_name: 'kontoutdrag.pdf',
  mime_type: 'application/pdf',
  size_bytes: 10,
  sha256: 'ab'.repeat(32),
  note: null,
  uploaded_by: 'user-1',
  uploaded_at: '2027-01-10T08:00:00Z',
  removed_at: null,
  removed_by: null,
  removed_reason: null,
}

describe('dashboard underlag routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listMock.mockResolvedValue([attachment])
    attachMock.mockResolvedValue(attachment)
    removeMock.mockResolvedValue({ ...attachment, removed_at: '2027-01-11T08:00:00Z', removed_by: 'user-1' })
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await listGET(createMockRequest('http://localhost/x?through_date=2026-12-31'), p({ accountKey: 'manual:2350' }))
    expect(res.status).toBe(401)
  })

  it('GET lists the files for the date, 400s without a date, 404s a bad key', async () => {
    const ok = await listGET(
      createMockRequest('http://localhost/api/reconciliation/accounts/manual:2350/attachments?through_date=2026-12-31&include_removed=1'),
      p({ accountKey: 'manual:2350' }),
    )
    expect(ok.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { attachments: unknown[] } }>(ok)
    expect(body.data.attachments).toHaveLength(1)
    expect(listMock).toHaveBeenCalledWith(supabase, 'company-1', 'manual:2350', '2026-12-31', { includeRemoved: true })

    const noDate = await listGET(createMockRequest('http://localhost/x'), p({ accountKey: 'manual:2350' }))
    expect(noDate.status).toBe(400)
    const badKey = await listGET(createMockRequest('http://localhost/x?through_date=2026-12-31'), p({ accountKey: '2350' }))
    expect(badKey.status).toBe(404)
  })

  it('POST attaches the multipart file with its date and note, and maps policy refusals to 400 + code', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'kontoutdrag.pdf', { type: 'application/pdf' }))
    form.set('through_date', '2026-12-31')
    form.set('note', 'Kontoutdrag december')
    const req = new Request('http://localhost/api/reconciliation/accounts/manual:2350/attachments', { method: 'POST', body: form })
    const res = await attachPOST(req as never, p({ accountKey: 'manual:2350' }))
    expect(res.status).toBe(201)
    expect(attachMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'manual:2350',
      expect.objectContaining({
        through_date: '2026-12-31',
        note: 'Kontoutdrag december',
        file: expect.objectContaining({ name: 'kontoutdrag.pdf', type: 'application/pdf', size: 4 }),
      }),
    )

    attachMock.mockRejectedValue(new ReconciliationAttachmentError('Filtypen stöds inte.', 'INVALID_FILE'))
    const form2 = new FormData()
    form2.set('file', new File(['x'], 'x.csv', { type: 'text/csv' }))
    form2.set('through_date', '2026-12-31')
    const refused = await attachPOST(new Request('http://localhost/x', { method: 'POST', body: form2 }) as never, p({ accountKey: 'manual:2350' }))
    expect(refused.status).toBe(400)
    expect((await parseJsonResponse<{ code: string }>(refused)).body.code).toBe('INVALID_FILE')
  })

  it('POST 400s without a file or a date, and requires write permission', async () => {
    const noFile = new FormData()
    noFile.set('through_date', '2026-12-31')
    const res = await attachPOST(new Request('http://localhost/x', { method: 'POST', body: noFile }) as never, p({ accountKey: 'manual:2350' }))
    expect(res.status).toBe(400)

    const noDate = new FormData()
    noDate.set('file', new File(['x'], 'x.pdf', { type: 'application/pdf' }))
    const res2 = await attachPOST(new Request('http://localhost/x', { method: 'POST', body: noDate }) as never, p({ accountKey: 'manual:2350' }))
    expect(res2.status).toBe(400)

    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) })
    const form = new FormData()
    form.set('file', new File(['x'], 'x.pdf', { type: 'application/pdf' }))
    form.set('through_date', '2026-12-31')
    const forbidden = await attachPOST(new Request('http://localhost/x', { method: 'POST', body: form }) as never, p({ accountKey: 'manual:2350' }))
    expect(forbidden.status).toBe(403)
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('GET file streams the bytes inline after the row authorizes, 404s otherwise', async () => {
    getRowMock.mockResolvedValue({ ...attachment, storage_bucket: 'documents', storage_path: 'documents/company-1/reconciliation/x' })
    downloadMock.mockResolvedValue({ blob: new Blob(['%PDF'], { type: 'application/pdf' }), error: null })
    const res = await fileGET(createMockRequest('http://localhost/x'), p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')

    getRowMock.mockResolvedValue(null)
    const missing = await fileGET(createMockRequest('http://localhost/x'), p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }))
    expect(missing.status).toBe(404)
    const badId = await fileGET(createMockRequest('http://localhost/x'), p({ accountKey: 'manual:2350', attachmentId: 'nope' }))
    expect(badId.status).toBe(404)
  })

  it('DELETE stamps removal with an optional reason, 409s an already removed file, 404s unknown', async () => {
    const res = await removeDELETE(
      createMockRequest('http://localhost/x', { method: 'DELETE', body: { reason: 'fel fil' } }),
      p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }),
    )
    expect(res.status).toBe(200)
    expect(removeMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'manual:2350', ATTACHMENT_ID, { reason: 'fel fil' })

    const empty = await removeDELETE(new Request('http://localhost/x', { method: 'DELETE' }) as never, p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }))
    expect(empty.status).toBe(200)
    expect(removeMock).toHaveBeenLastCalledWith(supabase, 'company-1', 'user-1', 'manual:2350', ATTACHMENT_ID, { reason: null })

    removeMock.mockRejectedValue(new ReconciliationAttachmentError('Underlaget är redan borttaget.', 'ALREADY_REMOVED'))
    const gone = await removeDELETE(new Request('http://localhost/x', { method: 'DELETE' }) as never, p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }))
    expect(gone.status).toBe(409)

    removeMock.mockResolvedValue(null)
    const unknown = await removeDELETE(new Request('http://localhost/x', { method: 'DELETE' }) as never, p({ accountKey: 'manual:2350', attachmentId: ATTACHMENT_ID }))
    expect(unknown.status).toBe(404)
  })
})
