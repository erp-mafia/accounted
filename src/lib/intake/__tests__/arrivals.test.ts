import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  apiKeyArrivalActor,
  ARRIVAL_SOURCES,
  arrivalOriginalBucket,
  buildArrivalOriginalPath,
  isArrivalSource,
  linkArrivalOutputs,
  listArrivalsForOutputs,
  recordArrival,
  recordDocumentArrival,
  safeArrivalFileName,
  sanitiseArrivalJson,
  storeArrivalOriginal,
  summariseArrivals,
  type ArrivalRow,
} from '../arrivals'
import { INTAKE_SOURCE_IDS } from '../sources'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const ARRIVAL_ID = '22222222-2222-4222-8222-222222222222'
const DOC_ID = '33333333-3333-4333-8333-333333333333'
const ITEM_ID = '44444444-4444-4444-8444-444444444444'

function arrivalRow(overrides: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id: ARRIVAL_ID,
    company_id: COMPANY,
    source: 'intake_email',
    source_ref: 'em_1',
    received_at: '2026-10-15T08:00:00.000Z',
    sender: { from: 'faktura@leverantor.example' },
    subject: 'Faktura 1001',
    message_text: 'Hej, här kommer fakturan.',
    original_path: null,
    original_sha256: null,
    original_mime: null,
    original_size: null,
    fetched_by: { type: 'webhook', label: 'resend-inbound' },
    source_meta: {},
    created_at: '2026-10-15T08:00:01.000Z',
    ...overrides,
  }
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient
let upload: ReturnType<typeof vi.fn>
let createSignedUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
  const bucket = mock.supabase.storage.from('documents') as { upload: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn> }
  upload = bucket.upload
  createSignedUrl = bucket.createSignedUrl
})

const baseInput = {
  companyId: COMPANY,
  source: 'intake_email' as const,
  sourceRef: 'em_1',
  receivedAt: '2026-10-15T08:00:00Z',
  sender: { from: 'faktura@leverantor.example', to: ['acme@inbox.example'] },
  subject: 'Faktura 1001',
  messageText: 'Hej, här kommer fakturan.',
  fetchedBy: { type: 'webhook' as const, label: 'resend-inbound' },
}

describe('source vocabulary', () => {
  it('holds exactly the canonical door ids', () => {
    expect([...ARRIVAL_SOURCES]).toEqual([
      'intake_email', 'mailbox', 'whatsapp', 'upload', 'peppol', 'partner_api', 'mcp', 'migration',
      'system', 'bank_feed', 'bank_file', 'sie', 'billo', 'kivra', 'paypal', 'portal',
    ])
    expect(isArrivalSource('peppol')).toBe(true)
    expect(isArrivalSource('email')).toBe(false)
    expect(isArrivalSource(undefined)).toBe(false)
  })

  it('is the intake sources list itself, not a copy that can drift', () => {
    expect(ARRIVAL_SOURCES).toBe(INTAKE_SOURCE_IDS)
  })
})

describe('apiKeyArrivalActor', () => {
  it("names a service account's key as the account, with its sponsor as the person", () => {
    expect(apiKeyArrivalActor({ userId: 'u-1', apiKeyId: 'k-1', apiKeyName: 'Partner key', serviceAccount: { id: 'sa-1', name: 'Partner' } })).toEqual({
      type: 'service_account', user_id: 'u-1', api_key_id: 'k-1', service_account_id: 'sa-1', label: 'Partner',
    })
  })

  it("names a person's key as the key, labelled with its name", () => {
    expect(apiKeyArrivalActor({ userId: 'u-1', apiKeyId: 'k-1', apiKeyName: 'My key', serviceAccount: null })).toEqual({
      type: 'api_key', user_id: 'u-1', api_key_id: 'k-1', label: 'My key',
    })
    expect(apiKeyArrivalActor({ userId: 'u-1' })).toEqual({ type: 'api_key', user_id: 'u-1' })
  })
})

describe('recordArrival', () => {
  it('returns the recorded arrival on a redelivery without fetching or storing the original again', async () => {
    mock.enqueue({ data: arrivalRow() })
    const fetchOriginal = vi.fn()
    const result = await recordArrival(supabase, { ...baseInput, original: fetchOriginal })

    expect(result).toEqual({ arrival: arrivalRow(), created: false })
    expect(fetchOriginal).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(mock.findCalls('arrivals', 'upsert')).toEqual([])
    expect(mock.findCalls('arrivals', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['source', 'intake_email'],
      ['source_ref', 'em_1'],
    ])
  })

  it('stores the original under the arrival key and writes its hash and size in the one insert', async () => {
    mock.enqueue({ data: null }) // lookup
    mock.enqueue({ data: [arrivalRow({ original_path: 'x' })] }) // upsert
    const bytes = new TextEncoder().encode('From: a@b\r\nSubject: x\r\n\r\nbody')
    const result = await recordArrival(supabase, {
      ...baseInput,
      original: async () => ({ bytes, filename: 'em_1.eml', mime: 'message/rfc822' }),
    })

    expect(result?.created).toBe(true)
    const [row, options] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>, Record<string, unknown>]
    expect(options).toEqual({ onConflict: 'company_id,source,source_ref', ignoreDuplicates: true })
    expect(row.original_path).toBe(`documents/${COMPANY}/arrivals/${row.id}/em_1.eml`)
    expect(row.original_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(row.original_mime).toBe('message/rfc822')
    expect(row.original_size).toBe(bytes.byteLength)
    expect(row.received_at).toBe('2026-10-15T08:00:00.000Z')
    expect(row.sender).toEqual({ from: 'faktura@leverantor.example', to: ['acme@inbox.example'] })
    expect(upload).toHaveBeenCalledWith(row.original_path, expect.any(ArrayBuffer), {
      contentType: 'message/rfc822',
      upsert: false,
    })
  })

  it('still records the arrival when the original cannot be fetched or stored, and says why', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [arrivalRow()] })
    const failedFetch = await recordArrival(supabase, {
      ...baseInput,
      original: async () => {
        throw new Error('raw download expired')
      },
    })
    expect(failedFetch?.created).toBe(true)
    let [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row.original_path).toBeNull()
    expect(row.source_meta).toEqual({ original_missing: 'fetch_failed' })

    mock.reset()
    mock.enqueue({ data: null })
    mock.enqueue({ data: [arrivalRow()] })
    upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket down' } })
    const failedStore = await recordArrival(supabase, {
      ...baseInput,
      original: { bytes: new Uint8Array([1, 2, 3]), filename: 'x.eml', mime: 'message/rfc822' },
    })
    expect(failedStore?.created).toBe(true)
    ;[row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row.original_path).toBeNull()
    expect(row.original_sha256).toBeNull()
    expect(row.source_meta).toEqual({ original_missing: 'store_failed' })
  })

  it('points at an archived original instead of storing it twice', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [arrivalRow({ source: 'peppol' })] })
    await recordArrival(supabase, {
      ...baseInput,
      source: 'peppol',
      original: { bytes: new Uint8Array([1]), filename: 'ignored.xml', mime: 'application/xml' },
      originalRef: { path: `documents/${COMPANY}/u/peppol.xml`, sha256: 'a'.repeat(64), mime: 'application/xml', size: 812 },
    })
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      original_path: `documents/${COMPANY}/u/peppol.xml`,
      original_sha256: 'a'.repeat(64),
      original_mime: 'application/xml',
      original_size: 812,
    })
    expect(upload).not.toHaveBeenCalled()
  })

  it('names the bucket of an original archived outside documents (an SIE file)', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [arrivalRow({ source: 'sie' })] })
    await recordArrival(supabase, {
      ...baseInput,
      source: 'sie',
      sourceMeta: { sie_import_id: 'import-1' },
      originalRef: { bucket: 'sie-files', path: `${COMPANY}/sie-originals/${'c'.repeat(64)}.se`, sha256: 'c'.repeat(64), size: 40 },
    })
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ original_path: `${COMPANY}/sie-originals/${'c'.repeat(64)}.se`, original_size: 40 })
    expect(row.source_meta).toEqual({ sie_import_id: 'import-1', original_bucket: 'sie-files' })
  })

  it('returns the concurrent winner when the insert lost the race', async () => {
    mock.enqueue({ data: null }) // lookup: nothing yet
    mock.enqueue({ data: [] }) // ON CONFLICT DO NOTHING: someone else got there
    mock.enqueue({ data: arrivalRow() }) // re-read
    const result = await recordArrival(supabase, baseInput)
    expect(result).toEqual({ arrival: arrivalRow(), created: false })
  })

  it('refuses an unknown source or an empty reference without touching the database', async () => {
    expect(await recordArrival(supabase, { ...baseInput, source: 'email' as never })).toBeNull()
    expect(await recordArrival(supabase, { ...baseInput, sourceRef: '   ' })).toBeNull()
    expect(await recordArrival(supabase, { ...baseInput, companyId: 'company-1' })).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('never throws: a database failure returns null', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: null, error: { message: 'permission denied for table arrivals' } })
    await expect(recordArrival(supabase, baseInput)).resolves.toBeNull()

    mock.reset()
    mock.enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(recordArrival(supabase, baseInput)).resolves.toBeNull()
  })

  it('strips NUL characters and caps the message text', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [arrivalRow()] })
    await recordArrival(supabase, {
      ...baseInput,
      subject: 'Fak\u0000tura',
      messageText: 'a\u0000'.repeat(60_000) + 'b'.repeat(60_000),
      sender: { from: 'x\u0000@y.example', skipped: undefined },
    })
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row.subject).toBe('Faktura')
    expect((row.message_text as string).includes('\u0000')).toBe(false)
    expect((row.message_text as string).length).toBe(100_000)
    expect(row.sender).toEqual({ from: 'x@y.example' })
  })
})

describe('storeArrivalOriginal', () => {
  it('returns null instead of throwing when Storage refuses', async () => {
    upload.mockRejectedValueOnce(new Error('network'))
    await expect(
      storeArrivalOriginal(supabase, { companyId: COMPANY, arrivalId: ARRIVAL_ID, bytes: new Uint8Array([1]), filename: 'a.eml', mime: 'message/rfc822' }),
    ).resolves.toBeNull()
  })
})

describe('linkArrivalOutputs', () => {
  it('links each output once, in order, idempotently', async () => {
    mock.enqueue({ data: null })
    const ok = await linkArrivalOutputs(supabase, { id: ARRIVAL_ID, company_id: COMPANY }, [
      { kind: 'document', id: DOC_ID, role: 'attachment' },
      { kind: 'inbox_item', id: ITEM_ID, role: 'attachment' },
      { kind: 'document', id: DOC_ID, role: 'body' },
      { kind: 'document', id: 'not-a-uuid', role: 'attachment' },
    ])
    expect(ok).toBe(true)
    const calls = mock.findCalls('arrival_outputs', 'upsert')
    for (const [, options] of calls) {
      expect(options).toEqual({ onConflict: 'arrival_id,output_kind,output_id', ignoreDuplicates: true })
    }
    expect(calls.map(([row]) => row)).toEqual([
      { arrival_id: ARRIVAL_ID, company_id: COMPANY, output_kind: 'document', output_id: DOC_ID, role: 'attachment', position: 0 },
      { arrival_id: ARRIVAL_ID, company_id: COMPANY, output_kind: 'inbox_item', output_id: ITEM_ID, role: 'attachment', position: 1 },
    ])
  })

  it('returns false on a database error and true for nothing to link', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await linkArrivalOutputs(supabase, { id: ARRIVAL_ID, company_id: COMPANY }, [{ kind: 'document', id: DOC_ID, role: 'attachment' }])).toBe(false)
    expect(await linkArrivalOutputs(supabase, { id: ARRIVAL_ID, company_id: COMPANY }, [])).toBe(true)
  })
})

describe('recordDocumentArrival', () => {
  it('points the arrival at the archived document and links the document and its inbox item', async () => {
    mock.enqueue({
      data: {
        id: DOC_ID,
        storage_path: `documents/${COMPANY}/user-1/1_kvitto.pdf`,
        sha256_hash: 'c'.repeat(64),
        mime_type: 'application/pdf',
        file_size_bytes: 2048,
        file_name: 'kvitto.pdf',
      },
    })
    mock.enqueue({ data: null }) // arrival lookup
    mock.enqueue({ data: [arrivalRow({ source: 'upload', source_ref: DOC_ID })] }) // upsert
    mock.enqueue({ data: null }) // outputs

    const result = await recordDocumentArrival(supabase, {
      companyId: COMPANY,
      source: 'upload',
      documentId: DOC_ID,
      inboxItemId: ITEM_ID,
      fetchedBy: { type: 'user', user_id: 'user-1' },
    })
    expect(result?.created).toBe(true)
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      source: 'upload',
      source_ref: DOC_ID,
      original_path: `documents/${COMPANY}/user-1/1_kvitto.pdf`,
      original_sha256: 'c'.repeat(64),
      original_mime: 'application/pdf',
      original_size: 2048,
      fetched_by: { type: 'user', user_id: 'user-1' },
      source_meta: { document_id: DOC_ID, file_name: 'kvitto.pdf' },
    })
    const outputs = mock.findCalls('arrival_outputs', 'upsert').map(([row]) => row as Record<string, unknown>)
    expect(outputs.map((o) => [o.output_kind, o.output_id])).toEqual([
      ['document', DOC_ID],
      ['inbox_item', ITEM_ID],
    ])
    expect(upload).not.toHaveBeenCalled()
  })

  it('records nothing for a document outside the company', async () => {
    mock.enqueue({ data: null })
    expect(
      await recordDocumentArrival(supabase, { companyId: COMPANY, source: 'upload', documentId: DOC_ID, fetchedBy: { type: 'user' } }),
    ).toBeNull()
    expect(mock.findCalls('arrivals', 'upsert')).toEqual([])
  })
})

describe('read path', () => {
  it('lists the arrivals behind an output with everything each produced, and signs the original', async () => {
    mock.enqueue({ data: [{ arrival_id: ARRIVAL_ID }] }) // outputs of the document
    mock.enqueue({
      data: [arrivalRow({ original_path: `documents/${COMPANY}/arrivals/${ARRIVAL_ID}/em_1.eml`, original_mime: 'message/rfc822', original_size: 10 })],
    })
    mock.enqueue({
      data: [
        { arrival_id: ARRIVAL_ID, output_kind: 'inbox_item', output_id: ITEM_ID, role: 'attachment', position: 1 },
        { arrival_id: ARRIVAL_ID, output_kind: 'document', output_id: DOC_ID, role: 'attachment', position: 0 },
      ],
    })

    const arrivals = await listArrivalsForOutputs(supabase, COMPANY, [{ kind: 'document', id: DOC_ID }])
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]!.outputs).toEqual([
      { kind: 'document', id: DOC_ID, role: 'attachment' },
      { kind: 'inbox_item', id: ITEM_ID, role: 'attachment' },
    ])
    expect(mock.findCalls('arrival_outputs', 'eq')[0]).toEqual(['company_id', COMPANY])

    const [summary] = await summariseArrivals(arrivals, { storageClient: supabase })
    expect(summary).toMatchObject({
      source: 'intake_email',
      has_original: true,
      original_file_name: 'em_1.eml',
      original_url: 'https://example.com/signed',
    })
    expect(createSignedUrl).toHaveBeenCalledWith(`documents/${COMPANY}/arrivals/${ARRIVAL_ID}/em_1.eml`, 300, { download: 'em_1.eml' })
  })

  it('leaves the URL out when signing fails, and asks nothing for no outputs', async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    const [summary] = await summariseArrivals(
      [{ ...arrivalRow({ original_path: `documents/${COMPANY}/arrivals/y/a.eml` }), outputs: [] }],
      { storageClient: supabase },
    )
    expect(summary!.original_url).toBeNull()
    expect(summary!.has_original).toBe(true)
    expect(await listArrivalsForOutputs(supabase, COMPANY, [{ kind: 'document', id: 'nope' }])).toEqual([])
  })
})

describe('original bucket', () => {
  it("signs a documents original only from the arrival's own company: its folder or one of its documents", async () => {
    const OTHER = '55555555-5555-4555-8555-555555555555'
    const legacy = arrivalRow({ id: 'a-legacy', original_path: 'user-1/1700000000000_faktura.pdf' })
    const foreign = arrivalRow({ id: 'a-foreign', original_path: `documents/${OTHER}/user-9/1_hemlig.pdf` })
    mock.enqueue({ data: [{ storage_path: 'user-1/1700000000000_faktura.pdf' }] }) // the company's documents among the paths

    const summaries = await summariseArrivals(
      [legacy, foreign].map((row) => ({ ...row, outputs: [] })),
      { storageClient: supabase },
    )
    expect(summaries.map((s) => [s.has_original, s.original_url])).toEqual([
      [true, 'https://example.com/signed'],
      [true, null],
    ])
    expect(createSignedUrl).toHaveBeenCalledTimes(1)
    expect(createSignedUrl).toHaveBeenCalledWith('user-1/1700000000000_faktura.pdf', 300, { download: '1700000000000_faktura.pdf' })
    expect(mock.findCall('document_attachments', 'eq')).toEqual(['company_id', COMPANY])
    expect(mock.findCall('document_attachments', 'in')).toEqual([
      'storage_path',
      ['user-1/1700000000000_faktura.pdf', `documents/${OTHER}/user-9/1_hemlig.pdf`],
    ])
  })

  it('signs nothing outside the company folder when the documents cannot be checked', async () => {
    mock.enqueue({ error: { message: 'boom' } })
    const [summary] = await summariseArrivals(
      [{ ...arrivalRow({ original_path: 'user-1/1_faktura.pdf' }), outputs: [] }],
      { storageClient: supabase },
    )
    expect(summary!.original_url).toBeNull()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('signs an SIE original in sie-files, and only under the arrival\'s own company', async () => {
    const own = arrivalRow({ source: 'sie', original_path: `${COMPANY}/sie-originals/a.se`, source_meta: { original_bucket: 'sie-files' } })
    const foreign = arrivalRow({ source: 'sie', original_path: `${ITEM_ID}/sie-originals/a.se`, source_meta: { original_bucket: 'sie-files' } })
    const unknown = arrivalRow({ original_path: `${COMPANY}/x/a.bin`, source_meta: { original_bucket: 'avatars' } })
    expect(arrivalOriginalBucket(arrivalRow())).toBe('documents')
    expect(arrivalOriginalBucket(own)).toBe('sie-files')
    expect(arrivalOriginalBucket(foreign)).toBeNull()
    expect(arrivalOriginalBucket(unknown)).toBeNull()

    const summaries = await summariseArrivals(
      [own, foreign, unknown].map((row) => ({ ...row, outputs: [] })),
      { storageClient: supabase },
    )
    expect(mock.supabase.storage.from).toHaveBeenCalledWith('sie-files')
    expect(createSignedUrl).toHaveBeenCalledTimes(1)
    expect(createSignedUrl).toHaveBeenCalledWith(`${COMPANY}/sie-originals/a.se`, 300, { download: 'a.se' })
    expect(summaries.map((s) => [s.has_original, s.original_url])).toEqual([
      [true, 'https://example.com/signed'],
      [true, null],
      [true, null],
    ])
  })
})

describe('helpers', () => {
  it('builds a plain storage key under the company folder', () => {
    expect(buildArrivalOriginalPath(COMPANY, ARRIVAL_ID, '../../Faktura maj (1).eml')).toBe(
      `documents/${COMPANY}/arrivals/${ARRIVAL_ID}/Faktura_maj_1.eml`,
    )
    expect(safeArrivalFileName('')).toBe('original')
  })

  it('makes any value jsonb-safe', () => {
    expect(sanitiseArrivalJson({ a: 'x\u0000y', b: [1, Infinity, null], c: undefined })).toEqual({ a: 'xy', b: [1, null, null] })
  })
})
