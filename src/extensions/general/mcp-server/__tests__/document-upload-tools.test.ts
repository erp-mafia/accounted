import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocumentAttachment } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { receiptImage } from '@/tests/fixtures/receipt-images'

const mocks = vi.hoisted(() => ({
  createPendingDocumentUpload: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
  findPendingDocumentUploadName: vi.fn(),
  uploadDocument: vi.fn(),
  extractInvoiceFields: vi.fn(),
  hasCapability: vi.fn(),
  mirrorExtractionToDocument: vi.fn(),
}))

// The paid OCR is gated at the OCR call (createDocumentInboxItem), not on the
// tools: entitled unless a test says otherwise.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: mocks.hasCapability }
})

vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', () => ({
  mirrorExtractionToDocument: mocks.mirrorExtractionToDocument,
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return {
    ...actual,
    createPendingDocumentUpload: mocks.createPendingDocumentUpload,
    completePendingDocumentUpload: mocks.completePendingDocumentUpload,
    findPendingDocumentUploadName: mocks.findPendingDocumentUploadName,
    uploadDocument: mocks.uploadDocument,
  }
})

vi.mock('@/lib/documents/inbox-extraction/extract-invoice-fields', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/documents/inbox-extraction/extract-invoice-fields')
  >()
  return { ...actual, extractInvoiceFields: mocks.extractInvoiceFields }
})

import { tools } from '../server'
import { uploadCompanyNote } from '../tool-reach'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const uploadId = '33333333-3333-4333-8333-333333333333'

function findTool(name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  // ilike/not/order/range serve the shared supplier matcher
  // (lib/suppliers/match-supplier.ts): name lookup and the vat_number scan.
  for (const method of ['select', 'eq', 'limit', 'insert', 'ilike', 'not', 'order']) {
    builder[method] = vi.fn().mockReturnValue(builder)
  }
  builder.maybeSingle = vi.fn().mockResolvedValue(result)
  builder.single = vi.fn().mockResolvedValue(result)
  builder.range = vi.fn().mockResolvedValue({ data: [], error: null })
  return builder
}

/**
 * The look before filing (lib/documents/queued-inbox-item.ts, crm#1413): the
 * items already on the document, read right before the insert.
 */
function queuedItems(rows: unknown[]) {
  const builder = makeQueryBuilder({ data: rows, error: null })
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
  return builder
}

describe('MCP model-free document upload tools', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasCapability.mockResolvedValue(true)
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl: 'https://storage.example/upload?token=signed',
      expiresAt: '2026-08-03T12:00:00.000Z',
    })
    mocks.completePendingDocumentUpload.mockResolvedValue({
      document: makeDocumentAttachment({
        id: uploadId,
        user_id: userId,
        company_id: companyId,
        file_name: 'invoice.pdf',
        mime_type: 'application/pdf',
      }),
      buffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer,
    })
    mocks.extractInvoiceFields.mockResolvedValue({
      data: {
        supplier: { name: 'Synthetic Supplier AB', orgNumber: null },
        invoice: { number: 'INV-1' },
      },
    })
  })

  // Claude Desktop's sandbox only reaches the MCP host: a signed URL on
  // <project>.supabase.co was refused there (2026-08-21), so the tool hands
  // out the same-origin /api/storage proxy URL instead. The signed token
  // travels in upload_headers, never in the URL (CASA 2.1.1).
  it('serves the upload URL from the app origin, with the token in upload_headers and not in the URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl:
        'https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/upload/sign/documents/co/user/pending/up/invoice.pdf?token=signed',
      expiresAt: '2026-08-03T12:00:00.000Z',
    })

    const result = (await findTool('gnubok_create_document_upload').execute(
      { file_name: 'invoice.pdf' },
      companyId,
      userId,
      {} as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      upload_url: 'https://app.accounted.se/api/storage/upload/sign/documents/co/user/pending/up/invoice.pdf',
      upload_headers: { Authorization: 'Bearer signed' },
    })
    expect(result.upload_url).not.toContain('token')
  })

  // crm#1455: on hosted the proxy runs in a function, and the platform
  // refuses a body over 4.5 MB before it starts, so a 5.2 MB photo got a bare
  // 413 while the tool promised 10 MB. The answer now names the real limit
  // and hands out the raw Storage URL for anything larger.
  it('states the proxy limit on hosted and hands out the direct Storage URL for larger files', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const signedUrl =
      'https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/upload/sign/documents/co/user/pending/up/kvitto.png?token=signed'
    mocks.createPendingDocumentUpload.mockResolvedValue({ uploadId, signedUrl, expiresAt: '2026-08-03T12:00:00.000Z' })

    const result = (await findTool('gnubok_create_document_upload').execute(
      { file_name: 'kvitto.png' },
      companyId,
      userId,
      {} as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      upload_url: 'https://app.accounted.se/api/storage/upload/sign/documents/co/user/pending/up/kvitto.png',
      upload_headers: { Authorization: 'Bearer signed' },
      max_bytes: 4 * 1024 * 1024,
      // Storage's own URL, token in its query as Storage requires: no headers go with it.
      direct_upload_url: signedUrl,
      direct_max_bytes: 10 * 1024 * 1024,
    })
    // The reported photo: over what upload_url carries, within the direct URL's limit.
    const photoBytes = 5.2 * 1000 * 1000
    expect(photoBytes).toBeGreaterThan(result.max_bytes as number)
    expect(photoBytes).toBeLessThan(result.direct_max_bytes as number)
    expect(result.notice).toMatch(/at most 4 MB.*up to 10 MB.*direct_upload_url, without upload_headers/)
  })

  it('self-hosted: the proxy has no platform cap, so upload_url carries the archive limit and no second URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://storage.self-hosted.example')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://books.self-hosted.example')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl: 'https://storage.self-hosted.example/storage/v1/object/upload/sign/documents/co/user/pending/up/a.pdf?token=signed',
      expiresAt: '2026-08-03T12:00:00.000Z',
    })

    const result = (await findTool('gnubok_create_document_upload').execute(
      { file_name: 'a.pdf' },
      companyId,
      userId,
      {} as never,
    )) as Record<string, unknown>

    expect(result.upload_url).toBe('https://books.self-hosted.example/api/storage/upload/sign/documents/co/user/pending/up/a.pdf')
    expect(result.upload_headers).toEqual({ Authorization: 'Bearer signed' })
    expect(result.max_bytes).toBe(10 * 1024 * 1024)
    expect(result).not.toHaveProperty('direct_upload_url')
    expect(result).not.toHaveProperty('notice')
  })

  it('returns an unauthenticated PUT URL without accepting file bytes', async () => {
    const tool = findTool('gnubok_create_document_upload')
    const result = await tool.execute(
      { file_name: 'invoice.pdf' },
      companyId,
      userId,
      {} as never,
    )

    expect(mocks.createPendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'invoice.pdf',
    )
    expect(result).toEqual({
      upload_id: uploadId,
      // Not our Storage host, so not rewritten: the raw signed URL, and no header to send.
      upload_url: 'https://storage.example/upload?token=signed',
      upload_headers: {},
      expires_at: '2026-08-03T12:00:00.000Z',
      // Not rewritten onto the proxy: nothing caps the PUT below the archive limit.
      max_bytes: 10 * 1024 * 1024,
    })
    const schema = tool.inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties).not.toHaveProperty('file_content_base64')
  })

  // crm#1862: on a key that reaches several companies an upload was aimed at
  // the default one, and nothing in the answer said how to aim it at another.
  // The dispatcher marks such a call (callable-via-parity.test.ts); the
  // answer above, without the mark, is what a single-company key gets.
  it('tells a caller that reaches several companies which company the upload belongs to and how to pick another', async () => {
    const result = (await findTool('gnubok_create_document_upload').execute(
      { file_name: 'invoice.pdf', __multiCompany: true },
      companyId,
      userId,
      {} as never,
    )) as Record<string, unknown>

    expect(result.company_note).toBe(uploadCompanyNote(companyId))
    expect(result.company_note).toContain(`This upload belongs to company ${companyId}`)
    expect(result.company_note).toContain('send the same company_id to gnubok_complete_document_upload')
    expect(result.company_note).toContain('start a new chat')
  })

  it('completes the reserved upload and uses the upload UUID for both records', async () => {
    const inboxInsert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      queuedItems([]),
      inboxInsert,
    ]
    const supplier = makeQueryBuilder({ data: null, error: null })
    // Nothing linked the document while extraction ran: no stamp.
    const documentLink = makeQueryBuilder({ data: { journal_entry_id: null }, error: null })
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      if (table === 'suppliers') return supplier
      if (table === 'document_attachments') return documentLink
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )
    expect(invoiceLookups).toHaveLength(0)

    expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      uploadId,
      'invoice.pdf',
      'application/pdf',
      undefined,
      // The inbox item created right after owns extraction; the
      // document-extraction extension must yield on the uploaded event.
      // Same bytes again land on the existing document (dedupeByContent).
      { extractionOwner: 'invoice-inbox', dedupeByContent: true },
    )
    expect(inboxInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadId, document_id: uploadId }),
    )
    expect(result).toMatchObject({
      document_id: uploadId,
      inbox_item_id: uploadId,
      status: 'received',
    })
    expect(mocks.extractInvoiceFields).toHaveBeenCalledOnce()
  })

  // crm#1848: underlag of verifikat that are already posted, uploaded to be
  // linked in bulk. Each file used to get an inbox item and, with the AI
  // package, a paid reading nobody would use.
  describe('archive_only', () => {
    const noInboxItem = () => {
      const lookups = [makeQueryBuilder({ data: null, error: null })]
      const inboxInserts: unknown[] = []
      const from = vi.fn((table: string) => {
        if (table === 'invoice_inbox_items') {
          const builder = lookups.shift() ?? makeQueryBuilder({ data: null, error: null })
          ;(builder.insert as ReturnType<typeof vi.fn>).mockImplementation((row: unknown) => {
            inboxInserts.push(row)
            return builder
          })
          return builder
        }
        // The arrival's read of the document; the arrival itself is best effort.
        if (table === 'document_attachments') return makeQueryBuilder({ data: null, error: null })
        throw new Error(`Unexpected table: ${table}`)
      })
      return { from, inboxInserts }
    }
    const complete = (from: unknown, args: Record<string, unknown> = {}) =>
      findTool('gnubok_complete_document_upload').execute(
        { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf', archive_only: true, ...args },
        companyId,
        userId,
        { from } as never,
      )

    it('archives the document, files no inbox item, reads nothing and names the link as the next call', async () => {
      const { from, inboxInserts } = noInboxItem()

      const result = await complete(from)

      expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
        expect.anything(),
        companyId,
        userId,
        uploadId,
        'invoice.pdf',
        'application/pdf',
        undefined,
        // 'none': the document-extraction extension stands down as well.
        { extractionOwner: 'none', dedupeByContent: true },
      )
      expect(inboxInserts).toEqual([])
      expect(mocks.extractInvoiceFields).not.toHaveBeenCalled()
      expect(mocks.hasCapability).not.toHaveBeenCalled()
      // The stamp Arkiv's routing reads (lib/documents/archive-only.ts).
      expect(mocks.mirrorExtractionToDocument).toHaveBeenCalledExactlyOnceWith(uploadId, {
        data: null,
        rawText: null,
        model: null,
        skipped: 'archive_only',
      })
      expect(result).toMatchObject({
        document_id: uploadId,
        inbox_item_id: null,
        status: 'archived',
        archive_only: true,
        next: { tool: 'gnubok_link_documents_to_vouchers' },
      })
    })

    it('a retry of the same upload answers the same and leaves the stamped row alone', async () => {
      mocks.completePendingDocumentUpload.mockResolvedValue({
        document: { ...makeDocumentAttachment({ id: uploadId, user_id: userId, company_id: companyId }), extraction_model: 'skipped:archive_only' },
        buffer: new ArrayBuffer(0),
      })
      const { from, inboxInserts } = noInboxItem()

      const result = await complete(from)

      expect(mocks.mirrorExtractionToDocument).not.toHaveBeenCalled()
      expect(inboxInserts).toEqual([])
      expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: null, archive_only: true })
    })

    it('stamps on a retry whose first attempt died after the extension stood down', async () => {
      mocks.completePendingDocumentUpload.mockResolvedValue({
        document: { ...makeDocumentAttachment({ id: uploadId, user_id: userId, company_id: companyId }), extraction_model: 'skipped:opted_out' },
        buffer: new ArrayBuffer(0),
      })

      await complete(noInboxItem().from)

      expect(mocks.mirrorExtractionToDocument).toHaveBeenCalledExactlyOnceWith(uploadId, expect.objectContaining({ skipped: 'archive_only' }))
    })

    it('never stamps a document that was read since: its reading stays', async () => {
      mocks.completePendingDocumentUpload.mockResolvedValue({
        document: { ...makeDocumentAttachment({ id: uploadId, user_id: userId, company_id: companyId }), extraction_model: 'some-model' },
        buffer: new ArrayBuffer(0),
      })

      await complete(noInboxItem().from)

      expect(mocks.mirrorExtractionToDocument).not.toHaveBeenCalled()
    })

    it('deduplicates as any upload: the archived document is answered and not stamped', async () => {
      const archivedId = '44444444-4444-4444-8444-444444444444'
      mocks.completePendingDocumentUpload.mockResolvedValue({
        document: { ...makeDocumentAttachment({ id: archivedId, user_id: userId, company_id: companyId }), deduplicated: true },
        buffer: new ArrayBuffer(0),
      })
      const { from, inboxInserts } = noInboxItem()

      const result = await complete(from)

      expect(result).toMatchObject({ document_id: archivedId, deduplicated: true, duplicate_of: archivedId })
      expect(result).not.toHaveProperty('archive_only')
      expect(mocks.mirrorExtractionToDocument).not.toHaveBeenCalled()
      expect(inboxInserts).toEqual([])
    })

    it('refuses a value that is not a boolean before anything is archived', async () => {
      await expect(complete(vi.fn(), { archive_only: 'yes' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(mocks.completePendingDocumentUpload).not.toHaveBeenCalled()
    })

    it('is opt-in: false is the ordinary upload', async () => {
      const lookups = [
        makeQueryBuilder({ data: null, error: null }),
        makeQueryBuilder({ data: null, error: null }),
        queuedItems([]),
        makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null }),
      ]
      const from = vi.fn((table: string) => {
        if (table === 'invoice_inbox_items') return lookups.shift()
        if (table === 'suppliers') return makeQueryBuilder({ data: null, error: null })
        if (table === 'document_attachments') return makeQueryBuilder({ data: { journal_entry_id: null }, error: null })
        throw new Error(`Unexpected table: ${table}`)
      })

      const result = await complete(from, { archive_only: false })

      expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
        expect.anything(),
        companyId,
        userId,
        uploadId,
        'invoice.pdf',
        'application/pdf',
        undefined,
        { extractionOwner: 'invoice-inbox', dedupeByContent: true },
      )
      expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
      expect(result).not.toHaveProperty('archive_only')
    })
  })

  // crm#1474: hosts do not enforce inputSchema.required, and complete with
  // only upload_id crashed "Cannot read properties of undefined (reading
  // 'split')" although the reservation already holds the name.
  it('completes with only upload_id: the name and type come from the reservation', async () => {
    mocks.findPendingDocumentUploadName.mockResolvedValue({ fileName: 'invoice.pdf', mimeType: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      queuedItems([]),
      makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null }),
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      if (table === 'suppliers') return makeQueryBuilder({ data: null, error: null })
      if (table === 'document_attachments') return makeQueryBuilder({ data: { journal_entry_id: null }, error: null })
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId },
      companyId,
      userId,
      { from } as never,
    )

    expect(mocks.findPendingDocumentUploadName).toHaveBeenCalledWith(expect.anything(), companyId, userId, uploadId)
    expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      uploadId,
      'invoice.pdf',
      'application/pdf',
      undefined,
      { extractionOwner: 'invoice-inbox', dedupeByContent: true },
    )
    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
    const schema = findTool('gnubok_complete_document_upload').inputSchema as { required: string[] }
    expect(schema.required).toEqual(['upload_id'])
  })

  it('answers DOCUMENT_UPLOAD_NOT_FOUND, not a TypeError, when only upload_id names nothing', async () => {
    mocks.findPendingDocumentUploadName.mockResolvedValue(null)
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return makeQueryBuilder({ data: null, error: null })
      throw new Error(`Unexpected table: ${table}`)
    })

    await expect(
      findTool('gnubok_complete_document_upload').execute({ upload_id: uploadId }, companyId, userId, { from } as never),
    ).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
    expect(mocks.completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('refuses a missing or empty upload_id before any read', async () => {
    const from = vi.fn()
    for (const args of [{}, { upload_id: '' }, { upload_id: 'not-a-uuid' }]) {
      await expect(
        findTool('gnubok_complete_document_upload').execute(args, companyId, userId, { from } as never),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    expect(from).not.toHaveBeenCalled()
  })

  it('refuses a missing file_name or file content with VALIDATION_ERROR on the tools that cannot derive it', async () => {
    await expect(
      findTool('gnubok_create_document_upload').execute({}, companyId, userId, {} as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      findTool('gnubok_upload_document').execute({ file_content_base64: 'JVBERi0=', mime_type: 'application/pdf' }, companyId, userId, {} as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      findTool('gnubok_upload_document').execute({ file_name: 'a.pdf' }, companyId, userId, {} as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mocks.createPendingDocumentUpload).not.toHaveBeenCalled()
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('without the AI capability archives the underlag with an empty reading and no OCR call', async () => {
    // A free-tier agent could not archive any underlag: the three upload
    // tools were gated on `ai` at dispatch. Like the dashboard upload
    // (no_ai_entitlement) the document is stored and the inbox item created;
    // only the paid extraction is skipped.
    mocks.hasCapability.mockResolvedValue(false)
    const inboxInsert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      queuedItems([]),
      inboxInsert,
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      if (table === 'suppliers') return makeQueryBuilder({ data: null, error: null })
      if (table === 'document_attachments') return makeQueryBuilder({ data: { journal_entry_id: null }, error: null })
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )

    expect(mocks.hasCapability).toHaveBeenCalledWith(expect.anything(), companyId, 'ai')
    expect(mocks.extractInvoiceFields).not.toHaveBeenCalled()
    expect(mocks.mirrorExtractionToDocument).toHaveBeenCalledWith(
      uploadId,
      expect.objectContaining({ rawText: null, skipped: 'no_ai_entitlement' }),
    )
    expect(inboxInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadId, document_id: uploadId, extraction_skipped: true }),
    )
    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId, status: 'received', extraction_skipped: true })
  })

  it('stamps the new inbox item when the document was linked to a verifikat while extraction ran (agent feedback seq 1003926)', async () => {
    // The agent holds the document id (the upload id) before this call
    // returns, and linked it with gnubok_link_document_to_voucher while the
    // extraction ran: that link found no inbox row to stamp.
    const stampCalls: Array<[string, ...unknown[]]> = []
    const stamp: Record<string, unknown> = {}
    for (const method of ['update', 'eq', 'is', 'select']) {
      stamp[method] = vi.fn((...args: unknown[]) => {
        stampCalls.push([method, ...args])
        return stamp
      })
    }
    stamp.then = (resolve: (v: unknown) => void) => resolve({ data: [{ id: uploadId }], error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      queuedItems([]),
      makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null }),
      stamp,
    ]
    const documentLink = makeQueryBuilder({ data: { journal_entry_id: 'je-a30' }, error: null })
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      if (table === 'suppliers') return makeQueryBuilder({ data: null, error: null })
      if (table === 'document_attachments') return documentLink
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )

    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
    expect(invoiceLookups).toHaveLength(0)
    expect(stampCalls).toEqual([
      ['update', { created_journal_entry_id: 'je-a30' }],
      ['eq', 'document_id', uploadId],
      ['eq', 'company_id', companyId],
      ['is', 'created_journal_entry_id', null],
      ['is', 'created_supplier_invoice_id', null],
      ['select', 'id'],
    ])
  })

  it('takes over the item Arkiv queued while the reading ran instead of filing a twin (crm#1413)', async () => {
    // Seen 2026-10-23: Arkiv classified the archived upload a minute before
    // the extraction finished and queued it ('partner_api', no reading); the
    // upload then filed its own item beside it. One upload, two items.
    const queuedId = '66666666-6666-4666-8666-666666666666'
    const reading = { supplier: { name: 'Synthetic Supplier AB', orgNumber: null }, invoice: { number: 'INV-1' } }
    const takeoverCalls: Array<[string, ...unknown[]]> = []
    const takeover: Record<string, unknown> = {}
    for (const method of ['update', 'eq', 'is', 'select']) {
      takeover[method] = vi.fn((...args: unknown[]) => {
        takeoverCalls.push([method, ...args])
        return takeover
      })
    }
    takeover.then = (resolve: (v: unknown) => void) =>
      resolve({ data: [{ id: queuedId, status: 'received', extracted_data: reading, matched_supplier_id: null, matched_transaction_id: null }], error: null })
    const insert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      queuedItems([{
        id: queuedId,
        status: 'received',
        extracted_data: null,
        matched_supplier_id: null,
        matched_transaction_id: null,
        created_supplier_invoice_id: null,
        created_journal_entry_id: null,
        channel_context: { intake_source: 'partner_api' },
      }]),
      takeover,
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') {
        const next = invoiceLookups.shift()
        return next ?? insert
      }
      if (table === 'suppliers') return makeQueryBuilder({ data: null, error: null })
      if (table === 'document_attachments') return makeQueryBuilder({ data: { journal_entry_id: null }, error: null })
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )

    expect(invoiceLookups).toHaveLength(0)
    expect(insert.insert).not.toHaveBeenCalled()
    expect(takeoverCalls[0]).toEqual(['update', expect.objectContaining({
      source: 'upload',
      channel_context: { intake_source: 'mcp' },
      extracted_data: reading,
      kind_hint: null,
    })])
    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: queuedId, status: 'received', extracted_data: reading })
  })

  it('answers with the existing document when the same bytes are already archived, creating nothing', async () => {
    const existingDocumentId = '44444444-4444-4444-8444-444444444444'
    mocks.completePendingDocumentUpload.mockResolvedValueOnce({
      document: makeDocumentAttachment({ id: existingDocumentId, user_id: userId, company_id: companyId, file_name: 'anmalan.pdf', mime_type: 'application/pdf', deduplicated: true } as never),
      buffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer,
    })
    const inboxLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: { id: 'inbox-old', status: 'booked', extracted_data: { invoice: { number: 'A-1' } }, matched_supplier_id: null }, error: null }),
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return inboxLookups.shift()
      throw new Error(`Unexpected table: ${table}`)
    })
    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'anmalan.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )
    expect(result).toEqual({ document_id: existingDocumentId, inbox_item_id: 'inbox-old', status: 'booked', extracted_data: { invoice: { number: 'A-1' } }, matched_supplier_id: null, deduplicated: true, duplicate_of: existingDocumentId })
    expect(mocks.extractInvoiceFields).not.toHaveBeenCalled()
    expect(inboxLookups).toHaveLength(0)
  })

  it('the legacy inline upload asks for the content dedupe and files its item as an MCP arrival', async () => {
    mocks.uploadDocument.mockResolvedValueOnce(makeDocumentAttachment({ id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' }))
    const insert = makeQueryBuilder({ data: { id: 'inbox-new', status: 'received' }, error: null })
    const empty = makeQueryBuilder({ data: null, error: null })
    const from = vi.fn((table: string) => (table === 'invoice_inbox_items' ? insert : empty))

    const result = await findTool('gnubok_upload_document').execute(
      { file_name: 'invoice.pdf', file_content_base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') },
      companyId,
      userId,
      { from } as never,
    )

    expect(mocks.uploadDocument.mock.calls[0][4]).toEqual({ upload_source: 'api', extractionOwner: 'invoice-inbox', dedupeByContent: true })
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({ source: 'upload', channel_context: { intake_source: 'mcp' } }))
    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: 'inbox-new', status: 'received' })
    expect(result).not.toHaveProperty('deduplicated')
  })

  it.each([
    ['its inbox item', { id: 'inbox-old', status: 'received', extracted_data: { invoice: { number: 'A-1' } }, matched_supplier_id: null }, 'inbox-old', 'received'],
    ['no inbox item (archived another way)', null, null, 'archived'],
  ])('the legacy inline upload answers the archived document with %s when the bytes are already there, creating nothing', async (_label, item, inboxItemId, status) => {
    const existingDocumentId = '55555555-5555-4555-8555-555555555555'
    mocks.uploadDocument.mockResolvedValueOnce({ ...makeDocumentAttachment({ id: existingDocumentId, file_name: 'kvitto.pdf', mime_type: 'application/pdf' }), deduplicated: true })
    const lookup = makeQueryBuilder({ data: item, error: null })
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return lookup
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_upload_document').execute(
      { file_name: 'kvitto.pdf', file_content_base64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') },
      companyId,
      userId,
      { from } as never,
    )

    expect(result).toMatchObject({ document_id: existingDocumentId, inbox_item_id: inboxItemId, status, deduplicated: true, duplicate_of: existingDocumentId })
    expect(lookup.insert).not.toHaveBeenCalled()
    expect(mocks.extractInvoiceFields).not.toHaveBeenCalled()
  })

  it('the legacy inline upload declares inbox_item_id nullable: a deduplicated upload may have no inbox item', () => {
    // Strict clients validate structuredContent against outputSchema (see the
    // matched_supplier_id case below); the dedupe fields are additive and
    // undeclared, which an open object schema allows.
    const schema = findTool('gnubok_upload_document').outputSchema as { properties: Record<string, { type: unknown }>; additionalProperties?: unknown }
    expect(schema.properties.inbox_item_id.type).toEqual(['string', 'null'])
    expect(schema.additionalProperties).not.toBe(false)
  })

  it('returns an already completed inbox item without downloading or extracting again', async () => {
    const existing = makeQueryBuilder({
      data: {
        id: uploadId,
        document_id: uploadId,
        status: 'received',
        extracted_data: { invoice: { number: 'INV-1' } },
        matched_supplier_id: null,
      },
      error: null,
    })
    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from: vi.fn().mockReturnValue(existing) } as never,
    )

    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
    expect(mocks.completePendingDocumentUpload).not.toHaveBeenCalled()
    expect(mocks.extractInvoiceFields).not.toHaveBeenCalled()
  })

  it.each(['signed', 'inline'])('uses detected MIME for extraction after %s image upload', async (path) => {
    const buffer = receiptImage('jpeg')
    const document = makeDocumentAttachment({ id: uploadId, file_name: 'receipt.png', mime_type: 'image/jpeg' })
    if (path === 'signed') mocks.completePendingDocumentUpload.mockResolvedValueOnce({ document, buffer })
    else mocks.uploadDocument.mockResolvedValueOnce(document)
    const empty = makeQueryBuilder({ data: null, error: null })
    const insert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const inboxQueries = path === 'signed' ? [empty, empty, queuedItems([]), insert] : [queuedItems([]), insert]
    const from = vi.fn((table: string) => table === 'invoice_inbox_items' ? inboxQueries.shift() : empty)
    const tool = findTool(path === 'signed' ? 'gnubok_complete_document_upload' : 'gnubok_upload_document')
    await tool.execute({
      file_name: 'receipt.png', mime_type: 'image/png',
      ...(path === 'signed' ? { upload_id: uploadId } : { file_content_base64: Buffer.from(buffer).toString('base64') }),
    }, companyId, userId, { from } as never)
    expect(mocks.extractInvoiceFields).toHaveBeenCalledWith(expect.objectContaining({
      buffer: Buffer.from(buffer), fileName: 'receipt.png', mimeType: 'image/jpeg',
    }))
  })

  // crm#1919: a scheduled agent whose sandbox may make no outbound request
  // could not PUT to upload_url, and nothing said the inline tool was the way
  // out. The proxy on the app origin does not help a client that reaches the
  // MCP host only.
  it('names the inline upload as the way out when the sandbox cannot reach upload_url', () => {
    const create = findTool('gnubok_create_document_upload')
    expect(create.description).toContain('If your sandbox cannot reach upload_url, use gnubok_upload_document instead.')
    // The tool it points at takes the bytes in the call itself.
    const inline = findTool('gnubok_upload_document').inputSchema as { required: string[] }
    expect(inline.required).toContain('file_content_base64')
  })

  it('keeps the scope aligned across all upload paths, with no tool-level AI gate', () => {
    for (const name of [
      'gnubok_create_document_upload',
      'gnubok_complete_document_upload',
      'gnubok_upload_document',
    ]) {
      expect(TOOL_SCOPE_MAP[name]).toBe('transactions:write')
      expect(MCP_TOOL_CAPABILITY_MAP[name]).toBeUndefined()
    }
  })

  it('declares matched_supplier_id nullable: unmatched suppliers return null (MCP feedback seq 261972)', () => {
    // Strict clients validate structuredContent against outputSchema; a bare
    // { type: 'string' } turned every unmatched upload into a client-side
    // validation error (and tripped the caller's circuit breaker) even though
    // the upload itself succeeded.
    for (const name of ['gnubok_complete_document_upload', 'gnubok_upload_document']) {
      const schema = findTool(name).outputSchema as {
        properties: Record<string, { type: unknown }>
        required: string[]
      }
      expect(schema.properties.matched_supplier_id.type).toEqual(['string', 'null'])
      expect(schema.required).not.toContain('matched_supplier_id')
    }
  })
})

/**
 * crm#1455 follow-up: gnubok_create_sie_upload hands out the same proxied
 * upload_url, under the same 4.5 MB platform cap on hosted, while a
 * multi-year SIE file runs to several MB. It now answers like the document
 * upload (documentUploadLimits): the proxy's limit, and the raw Storage URL
 * for a file up to the SIE import's own limit.
 */
describe('gnubok_create_sie_upload: the real limit and the direct Storage URL', () => {
  const sieUpload = () => findTool('gnubok_create_sie_upload')
  // The tool also reads the target company's name and org number for the
  // card: every read answers empty, which the tool tolerates.
  const supabase = { from: vi.fn(() => makeQueryBuilder({ data: null, error: null })) }
  const run = () => sieUpload().execute({ filename: 'export.se' }, companyId, userId, supabase as never) as Promise<Record<string, unknown>>

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('on hosted: upload_url takes 4 MB, direct_upload_url the import limit of 50 MB', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const signedUrl =
      'https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/upload/sign/documents/co/user/pending/up/export.se?token=signed'
    mocks.createPendingDocumentUpload.mockResolvedValue({ uploadId, signedUrl, expiresAt: '2026-10-28T12:00:00.000Z' })

    const result = await run()

    expect(result).toMatchObject({
      upload_id: uploadId,
      upload_url: 'https://app.accounted.se/api/storage/upload/sign/documents/co/user/pending/up/export.se',
      upload_headers: { Authorization: 'Bearer signed' },
      max_bytes: 4 * 1024 * 1024,
      direct_upload_url: signedUrl,
      direct_max_bytes: 50 * 1024 * 1024,
    })
    expect(result.notice).toMatch(/at most 4 MB.*up to 50 MB.*direct_upload_url, without upload_headers/)
  })

  it('self-hosted: upload_url carries the import limit and no second URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://storage.self-hosted.example')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://books.self-hosted.example')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl: 'https://storage.self-hosted.example/storage/v1/object/upload/sign/documents/co/user/pending/up/export.se?token=signed',
      expiresAt: '2026-10-28T12:00:00.000Z',
    })

    const result = await run()

    expect(result.upload_url).toBe('https://books.self-hosted.example/api/storage/upload/sign/documents/co/user/pending/up/export.se')
    expect(result.upload_headers).toEqual({ Authorization: 'Bearer signed' })
    expect(result.max_bytes).toBe(50 * 1024 * 1024)
    expect(result).not.toHaveProperty('direct_upload_url')
    expect(result).not.toHaveProperty('notice')
  })

  // CASA 2.1.1: both upload tools say where the token goes before the agent PUTs.
  it('names upload_headers in both upload descriptions', () => {
    expect(sieUpload().description).toContain('upload_url with upload_headers')
    expect(findTool('gnubok_create_document_upload').description).toContain('upload_url with upload_headers')
  })

  it('states the limit by reference, not a false fixed number', () => {
    expect(sieUpload().description).toContain('(see max_bytes)')
    expect(sieUpload().description).not.toContain('max 50 MB')
  })
})
