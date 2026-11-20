import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockUploadDocument = vi.fn()

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

import { archiveRotRutPayoutFile } from '@/lib/invoices/rot-rut-service'

/**
 * archiveRotRutPayoutFile: the one archive step behind the web route
 * (best-effort) and the MCP tool (the only way its file leaves the server).
 */

const FILE = { xml: '<ns1:Begaran/>', file_name: 'rot_begaran_2026-10-22.xml' }

describe('archiveRotRutPayoutFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUploadDocument.mockResolvedValue({ id: 'doc-1', storage_path: 'user-1/doc-1.xml' })
  })

  it('stores the file as system räkenskapsinformation and points the begäran at it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })

    const archived = await archiveRotRutPayoutFile(supabase as unknown as SupabaseClient, 'user-1', 'company-1', 'req-1', FILE)

    expect(archived).toEqual({ documentId: 'doc-1', storagePath: 'user-1/doc-1.xml', linked: true })
    const [, userId, companyId, file, metadata] = mockUploadDocument.mock.calls[0]
    expect([userId, companyId]).toEqual(['user-1', 'company-1'])
    expect(file.name).toBe(FILE.file_name)
    expect(new TextDecoder().decode(file.buffer)).toBe(FILE.xml)
    expect(metadata).toEqual({ upload_source: 'system' })
    expect(findCalls('rot_rut_payout_requests', 'update')).toEqual([[{ file_document_id: 'doc-1' }]])
    expect(findCalls('rot_rut_payout_requests', 'eq')).toEqual([['id', 'req-1'], ['company_id', 'company-1']])
  })

  it('reports linked=false when the pointer update fails: the file is archived either way', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'update failed' } })

    const archived = await archiveRotRutPayoutFile(supabase as unknown as SupabaseClient, 'user-1', 'company-1', 'req-1', FILE)

    expect(archived.linked).toBe(false)
    expect(archived.documentId).toBe('doc-1')
  })

  it('throws when the file cannot be stored, before touching the begäran', async () => {
    mockUploadDocument.mockRejectedValue(new Error('storage unavailable'))
    const { supabase } = createQueuedMockSupabase()

    await expect(
      archiveRotRutPayoutFile(supabase as unknown as SupabaseClient, 'user-1', 'company-1', 'req-1', FILE),
    ).rejects.toThrow('storage unavailable')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
