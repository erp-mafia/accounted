import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SpendFile } from '@accounted/connect-contract'
import { MAX_DOCUMENT_SIZE } from '@/lib/core/documents/document-service'

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  readBodyWithCap: vi.fn(),
  uploadDocument: vi.fn(),
}))

vi.mock('@/lib/http/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/safe-fetch')>()),
  safeFetch: mocks.safeFetch,
  readBodyWithCap: mocks.readBodyWithCap,
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: mocks.uploadDocument,
}))

import { receiptRejectionSv, storeSpendReceipts } from '../receipts'

const admin = { from: vi.fn() } as unknown as SupabaseClient
const ARGS = { companyId: 'company-1', userId: 'user-1', itemId: 'item-1' }
const PDF = Buffer.from('%PDF-1.4 kvitto 125 kr')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function file(overrides: Partial<SpendFile> = {}, bytes: Buffer = PDF): SpendFile {
  return {
    fileRef: 'file-1',
    name: 'kvitto.pdf',
    contentType: 'application/pdf',
    size: bytes.length,
    sha256: sha(bytes),
    downloadUrl: 'https://files.connect.example.se/f/file-1',
    downloadExpiresAt: '2026-10-17T10:15:00Z',
    ...overrides,
  }
}

/** Serves each download URL its bytes, as the service's copy would. */
function serve(files: Record<string, Buffer>) {
  mocks.safeFetch.mockImplementation(async (url: string) => {
    const bytes = files[url]
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('gone', { status: 404 })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readBodyWithCap.mockImplementation(async (res: Response) => Buffer.from(await res.arrayBuffer()))
  let next = 0
  mocks.uploadDocument.mockImplementation(async () => ({ id: `doc-${++next}` }))
})

describe('storeSpendReceipts', () => {
  it('downloads each file, checks its sha256 and stores it as a document in the order sent', async () => {
    const pdf = file()
    const jpeg = file({ fileRef: 'file-2', name: null, contentType: 'image/jpeg', downloadUrl: 'https://files.connect.example.se/f/file-2' }, JPEG)
    serve({ [pdf.downloadUrl]: PDF, [jpeg.downloadUrl]: JPEG })
    const receiptDeps = { fetchImpl: vi.fn() as unknown as typeof fetch }

    const outcome = await storeSpendReceipts(admin, { ...ARGS, files: [pdf, jpeg] }, receiptDeps)

    expect(outcome).toEqual({ ok: true, documentIds: ['doc-1', 'doc-2'] })
    expect(mocks.safeFetch).toHaveBeenNthCalledWith(1, pdf.downloadUrl, { method: 'GET', cache: 'no-store' }, {}, receiptDeps)
    expect(mocks.readBodyWithCap).toHaveBeenCalledWith(expect.any(Response), MAX_DOCUMENT_SIZE)

    const [client, userId, companyId, stored, metadata] = mocks.uploadDocument.mock.calls[0]
    expect(client).toBe(admin)
    expect(userId).toBe('user-1')
    expect(companyId).toBe('company-1')
    expect(stored).toMatchObject({ name: 'kvitto.pdf', type: 'application/pdf' })
    // Kept exactly as delivered (BFL 7 kap): the stored bytes are the downloaded bytes.
    expect(Buffer.from(stored.buffer as ArrayBuffer).equals(PDF)).toBe(true)
    // One document per item and file, whatever the run: no AI reading, the provider coded it.
    expect(metadata).toEqual({ upload_source: 'api', idempotency_key: 'spend:item-1:file-1', extractionOwner: 'none' })

    // A file without a name is named after its place and type.
    expect(mocks.uploadDocument.mock.calls[1][3]).toMatchObject({ name: 'kvitto-2.jpg', type: 'image/jpeg' })
    expect(mocks.uploadDocument.mock.calls[1][4]).toMatchObject({ idempotency_key: 'spend:item-1:file-2' })
  })

  it('stores nothing and answers ok for an expense without files', async () => {
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [] })).toEqual({ ok: true, documentIds: [] })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('refuses a type the ledger does not accept, for good and without downloading it', async () => {
    const html = file({ name: 'sida.html', contentType: 'text/html' })
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [html] })).toEqual({
      ok: false,
      permanent: true,
      reason: 'type_not_accepted',
      fileName: 'sida.html',
    })
    const unnamed = file({ name: null, contentType: 'application/zip' })
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [unnamed] })).toMatchObject({ reason: 'type_not_accepted', fileName: 'kvitto-1.bin' })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses a file over 10 MB for good: by its stated size before downloading, by its body when the size lied', async () => {
    const stated = file({ size: MAX_DOCUMENT_SIZE + 1 })
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [stated] })).toMatchObject({ ok: false, permanent: true, reason: 'too_large' })
    expect(mocks.safeFetch).not.toHaveBeenCalled()

    const lied = file()
    serve({ [lied.downloadUrl]: PDF })
    mocks.readBodyWithCap.mockResolvedValueOnce(null)
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [lied] })).toEqual({ ok: false, permanent: true, reason: 'too_large', fileName: 'kvitto.pdf' })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('treats a failed download and a checksum mismatch as transient: the next run gets a fresh link', async () => {
    const missing = file()
    serve({})
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [missing] })).toEqual({
      ok: false,
      permanent: false,
      reason: 'download_failed',
      fileName: 'kvitto.pdf',
    })

    mocks.safeFetch.mockRejectedValueOnce(new Error('blocked address'))
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [file()] })).toMatchObject({ ok: false, permanent: false, reason: 'download_failed' })

    const tampered = file({ sha256: 'b'.repeat(64) })
    serve({ [tampered.downloadUrl]: PDF })
    expect(await storeSpendReceipts(admin, { ...ARGS, files: [tampered] })).toMatchObject({ ok: false, permanent: false, reason: 'checksum_mismatch' })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('treats a store that fails as transient, and stops at the first failing file', async () => {
    const first = file()
    const second = file({ fileRef: 'file-2', name: 'kvitto-2.pdf', downloadUrl: 'https://files.connect.example.se/f/file-2' })
    const third = file({ fileRef: 'file-3', name: 'kvitto-3.pdf', downloadUrl: 'https://files.connect.example.se/f/file-3' })
    serve({ [first.downloadUrl]: PDF, [second.downloadUrl]: PDF, [third.downloadUrl]: PDF })
    mocks.uploadDocument.mockResolvedValueOnce({ id: 'doc-1' }).mockRejectedValueOnce(new Error('Failed to upload document: timeout'))

    expect(await storeSpendReceipts(admin, { ...ARGS, files: [first, second, third] })).toEqual({
      ok: false,
      permanent: false,
      reason: 'store_failed',
      fileName: 'kvitto-2.pdf',
    })
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(2)
  })

  it('rejects content that is not what its type says before storing it: that file never becomes storable', async () => {
    const lying = file({ name: 'kvitto.pdf' }, JPEG)
    serve({ [lying.downloadUrl]: JPEG })

    expect(await storeSpendReceipts(admin, { ...ARGS, files: [lying] })).toEqual({
      ok: false,
      permanent: true,
      reason: 'type_not_accepted',
      fileName: 'kvitto.pdf',
    })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })
})

describe('receiptRejectionSv', () => {
  it('tells the provider in Swedish which file failed and what to upload instead', () => {
    expect(receiptRejectionSv({ ok: false, permanent: true, reason: 'too_large', fileName: 'kvitto.pdf' })).toBe(
      'Kvittot kvitto.pdf kan inte sparas i Accounted (filen är större än 10 MB). Ladda upp en PDF eller en bild under 10 MB och exportera igen.',
    )
    expect(receiptRejectionSv({ ok: false, permanent: true, reason: 'type_not_accepted', fileName: 'sida.html' })).toBe(
      'Kvittot sida.html kan inte sparas i Accounted (filtypen tas inte emot). Ladda upp en PDF eller en bild under 10 MB och exportera igen.',
    )
    expect(receiptRejectionSv({ ok: false, permanent: true, reason: 'store_failed', fileName: 'kvitto.pdf' })).toBe(
      'Kvittot kvitto.pdf kan inte sparas i Accounted (filen gick inte att läsa). Ladda upp en PDF eller en bild under 10 MB och exportera igen.',
    )
  })

  it('stays within the 500 characters the acknowledgement takes', () => {
    const longName = `${'k'.repeat(251)}.pdf`
    expect(receiptRejectionSv({ ok: false, permanent: true, reason: 'too_large', fileName: longName }).length).toBeLessThanOrEqual(500)
  })
})
