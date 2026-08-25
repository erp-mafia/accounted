import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const listRowsMock = vi.fn()
const insertRowMock = vi.fn()
const getRowMock = vi.fn()
const stampMock = vi.fn()
vi.mock('../attachments-store', async () => {
  const actual = await vi.importActual<typeof import('../attachments-store')>('../attachments-store')
  return {
    ...actual,
    listAttachmentRows: (...args: unknown[]) => listRowsMock(...args),
    insertAttachmentRow: (...args: unknown[]) => insertRowMock(...args),
    getAttachmentRow: (...args: unknown[]) => getRowMock(...args),
    stampAttachmentRemoved: (...args: unknown[]) => stampMock(...args),
  }
})

import {
  attachUnderlag,
  attachmentStoragePath,
  listAttachments,
  ReconciliationAttachmentError,
  removeUnderlag,
} from '../attachments'

const COMPANY = 'company-1'
const USER = 'user-1'
// %PDF-1.4 header followed by padding: passes the magic-byte check.
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n').buffer as ArrayBuffer

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    account_key: 'manual:2350',
    through_date: '2026-12-31',
    file_name: 'engagemangsbesked.pdf',
    mime_type: 'application/pdf',
    size_bytes: PDF_BYTES.byteLength,
    storage_bucket: 'documents',
    storage_path: `documents/${COMPANY}/reconciliation/manual_2350/2026-12-31/x_engagemangsbesked.pdf`,
    sha256: 'ab'.repeat(32),
    note: null,
    uploaded_by: USER,
    uploaded_at: '2027-01-10T08:00:00Z',
    removed_at: null,
    removed_by: null,
    removed_reason: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listRowsMock.mockReset()
  insertRowMock.mockReset()
  getRowMock.mockReset()
  stampMock.mockReset()
})

describe('attachmentStoragePath', () => {
  it('lives under documents/<company>/ so the bucket RLS applies, with the key colon replaced', () => {
    const p = attachmentStoragePath(COMPANY, 'manual:2350', '2026-12-31', 'Kontoutdrag dec/2026.pdf', 'abc')
    expect(p).toBe(`documents/${COMPANY}/reconciliation/manual_2350/2026-12-31/abc_Kontoutdrag dec_2026.pdf`)
  })
})

describe('listAttachments', () => {
  it('returns the public shape and rejects a bad scope', async () => {
    const { supabase } = createQueuedMockSupabase()
    listRowsMock.mockResolvedValue([row()])
    const list = await listAttachments(supabase as never, COMPANY, 'manual:2350', '2026-12-31')
    expect(list[0]).not.toHaveProperty('storage_path')
    expect(list[0].file_name).toBe('engagemangsbesked.pdf')
    await expect(listAttachments(supabase as never, COMPANY, '2350', '2026-12-31')).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_KEY' })
    await expect(listAttachments(supabase as never, COMPANY, 'manual:2350', '31/12/2026')).rejects.toMatchObject({ code: 'INVALID_DATE' })
  })
})

describe('attachUnderlag', () => {
  it('validates, hashes, uploads to the documents bucket, then records the row', async () => {
    const { supabase } = createQueuedMockSupabase()
    insertRowMock.mockImplementation(async (_s: unknown, _c: unknown, input: Record<string, unknown>) => row(input))
    const result = await attachUnderlag(supabase as never, COMPANY, USER, 'manual:2350', {
      through_date: '2026-12-31',
      note: '  Engagemangsbesked  ',
      file: { name: 'engagemangsbesked.pdf', type: 'application/pdf', size: PDF_BYTES.byteLength, buffer: PDF_BYTES },
    })
    const upload = supabase.storage.from('documents').upload as ReturnType<typeof vi.fn>
    expect(supabase.storage.from).toHaveBeenCalledWith('documents')
    const [path, , opts] = upload.mock.calls[0] as [string, unknown, { contentType: string; upsert: boolean }]
    expect(path).toMatch(new RegExp(`^documents/${COMPANY}/reconciliation/manual_2350/2026-12-31/`))
    expect(opts).toEqual({ contentType: 'application/pdf', upsert: false })
    expect(insertRowMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      expect.objectContaining({
        account_key: 'manual:2350',
        through_date: '2026-12-31',
        note: 'Engagemangsbesked',
        uploaded_by: USER,
        storage_bucket: 'documents',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
    expect(result.file_name).toBe('engagemangsbesked.pdf')
  })

  it('refuses unsupported types and content that does not match the declared type without uploading', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      attachUnderlag(supabase as never, COMPANY, USER, 'manual:2350', {
        through_date: '2026-12-31',
        file: { name: 'x.csv', type: 'text/csv', size: 10, buffer: new ArrayBuffer(10) },
      }),
    ).rejects.toBeInstanceOf(ReconciliationAttachmentError)
    await expect(
      attachUnderlag(supabase as never, COMPANY, USER, 'manual:2350', {
        through_date: '2026-12-31',
        file: { name: 'x.pdf', type: 'application/pdf', size: 10, buffer: new ArrayBuffer(10) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE' })
    expect(supabase.storage.from('documents').upload).not.toHaveBeenCalled()
    expect(insertRowMock).not.toHaveBeenCalled()
  })

  it('does not record a row when the upload fails', async () => {
    const { supabase } = createQueuedMockSupabase()
    ;(supabase.storage.from('documents').upload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: { message: 'bucket down' },
    })
    await expect(
      attachUnderlag(supabase as never, COMPANY, USER, 'manual:2350', {
        through_date: '2026-12-31',
        file: { name: 'x.pdf', type: 'application/pdf', size: PDF_BYTES.byteLength, buffer: PDF_BYTES },
      }),
    ).rejects.toThrow(/bucket down/)
    expect(insertRowMock).not.toHaveBeenCalled()
  })
})

describe('removeUnderlag', () => {
  it('stamps an active row, refuses a removed one, and returns null for an unknown id', async () => {
    const { supabase } = createQueuedMockSupabase()
    getRowMock.mockResolvedValue(row())
    stampMock.mockResolvedValue(row({ removed_at: '2027-01-11T08:00:00Z', removed_by: USER, removed_reason: 'fel fil' }))
    const removed = await removeUnderlag(supabase as never, COMPANY, USER, 'manual:2350', row().id, { reason: ' fel fil ' })
    expect(removed?.removed_reason).toBe('fel fil')
    expect(stampMock).toHaveBeenCalledWith(supabase, COMPANY, row().id, { removed_by: USER, reason: 'fel fil' })

    getRowMock.mockResolvedValue(row({ removed_at: '2027-01-11T08:00:00Z', removed_by: USER }))
    await expect(removeUnderlag(supabase as never, COMPANY, USER, 'manual:2350', row().id)).rejects.toMatchObject({ code: 'ALREADY_REMOVED' })

    getRowMock.mockResolvedValue(null)
    expect(await removeUnderlag(supabase as never, COMPANY, USER, 'manual:2350', row().id)).toBeNull()
  })
})
