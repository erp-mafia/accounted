import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'

vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: vi.fn(),
  linkToJournalEntry: vi.fn(),
  uploadDocument: vi.fn().mockResolvedValue({ id: 'copy-1' }),
}))

import { downloadDocumentObject, linkToJournalEntry, uploadDocument } from '@/lib/core/documents/document-service'
import { copyDocumentToVoucher, linkDocumentOnce } from '../underlag'

const COMPANY = 'company-1'
const BYTES = new TextEncoder().encode('%PDF-1.4 settlement')
const SHA = createHash('sha256').update(BYTES).digest('hex')

let mem: MemorySupabase

beforeEach(() => {
  vi.clearAllMocks()
  mem = createMemorySupabase()
  mem.seed('document_attachments', [
    { id: 'doc-1', company_id: COMPANY, storage_path: 'company-1/u/a.pdf', file_name: 'Avrakning.pdf', mime_type: 'application/pdf', sha256_hash: SHA, journal_entry_id: 'je-d1' },
    { id: 'doc-free', company_id: COMPANY, journal_entry_id: null },
  ])
  vi.mocked(downloadDocumentObject).mockResolvedValue({ blob: new Blob([BYTES]), error: null, resolvedPath: 'company-1/u/a.pdf' })
})

describe('linkDocumentOnce', () => {
  it('links a free document, leaves one already on the voucher, and never moves one from another voucher', async () => {
    const db = mem.client as SupabaseClient
    expect(await linkDocumentOnce(db, COMPANY, 'doc-free', 'je-c1')).toBe(true)
    expect(linkToJournalEntry).toHaveBeenCalledWith(db, COMPANY, 'doc-free', 'je-c1', expect.objectContaining({ link_basis: 'system_derived' }))
    vi.mocked(linkToJournalEntry).mockClear()
    expect(await linkDocumentOnce(db, COMPANY, 'doc-1', 'je-d1')).toBe(true)
    expect(await linkDocumentOnce(db, COMPANY, 'doc-1', 'je-c1')).toBe(false)
    expect(await linkDocumentOnce(db, COMPANY, null, 'je-c1')).toBe(false)
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })
})

describe('copyDocumentToVoucher', () => {
  it('archives the same bytes on the other voucher under a deterministic key', async () => {
    const db = mem.client as SupabaseClient
    const id = await copyDocumentToVoucher(db, { companyId: COMPANY, userId: 'u-1', documentId: 'doc-1', journalEntryId: 'je-c1', scope: 'collection-settlement:s-1' })
    expect(id).toBe('copy-1')
    const [, userId, companyId, file, metadata] = vi.mocked(uploadDocument).mock.calls[0]!
    expect([userId, companyId, file.name, file.type]).toEqual(['u-1', COMPANY, 'Avrakning.pdf', 'application/pdf'])
    expect(new Uint8Array(file.buffer)).toEqual(BYTES)
    expect(metadata).toEqual({
      upload_source: 'system',
      journal_entry_id: 'je-c1',
      linkBasis: expect.objectContaining({ link_basis: 'system_derived' }),
      idempotency_key: 'collection-settlement:s-1:je-c1',
      extractionOwner: 'none',
    })
  })

  it('refuses bytes that do not match the recorded hash', async () => {
    vi.mocked(downloadDocumentObject).mockResolvedValue({ blob: new Blob(['tampered']), error: null, resolvedPath: 'x' })
    await expect(
      copyDocumentToVoucher(mem.client as SupabaseClient, { companyId: COMPANY, userId: 'u-1', documentId: 'doc-1', journalEntryId: 'je-c1', scope: 's' }),
    ).rejects.toThrow('does not match its recorded hash')
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses a document of another company', async () => {
    await expect(
      copyDocumentToVoucher(mem.client as SupabaseClient, { companyId: 'company-2', userId: 'u-1', documentId: 'doc-1', journalEntryId: 'je-c1', scope: 's' }),
    ).rejects.toThrow('not found')
  })
})
