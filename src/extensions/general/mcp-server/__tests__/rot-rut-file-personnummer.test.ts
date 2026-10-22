import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * gnubok_generate_rot_rut_file never hands the begäran XML to the model
 * (issue #58, personnummer and secrets): the file names every buyer by full
 * personnummer, as Skatteverket's schema requires, and the MCP surface masks
 * personnummer. The agent gets a link to the archived file for the user to
 * upload; the per-invoice summary keeps only the last four digits.
 */

const mockListCandidates = vi.fn()
const mockCreateRequest = vi.fn()
const mockUploadDocument = vi.fn()

vi.mock('@/lib/invoices/rot-rut-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/rot-rut-service')>()),
  listRotRutCandidates: (...args: unknown[]) => mockListCandidates(...args),
  createRotRutPayoutRequest: (...args: unknown[]) => mockCreateRequest(...args),
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

import { tools } from '../server'

const tool = tools.find((candidate) => candidate.name === 'gnubok_generate_rot_rut_file')!

const COMPANY = 'company-1'
const USER = 'user-1'
const REQUEST_ID = 'req-1'
const DOCUMENT_ID = 'doc-1'
// Synthetic test identity from Skatteverket's official example files.
const BUYER_PERSONNUMMER = '198406012388'
const XML = `<?xml version="1.0" encoding="UTF-8"?>\n<ns1:Begaran><ns2:Kopare>${BUYER_PERSONNUMMER}</ns2:Kopare></ns1:Begaran>`

const ARENDE = {
  invoice_id: 'inv-1',
  invoice_number: '1001',
  personnummer_last4: BUYER_PERSONNUMMER.slice(-4),
  begart_belopp: 5000,
}

function candidates() {
  return { ok: true, eligible: [ARENDE], blocked: [], other_type_counts: {} }
}

function created() {
  return {
    ok: true,
    request: { id: REQUEST_ID, status: 'generated' },
    file: {
      xml: XML,
      file_name: 'rut_begaran_2026-10-22.xml',
      arenden: [ARENDE],
      blockers: [],
      warnings: [],
      requested_total: 5000,
    },
  }
}

type GeneratedResult = {
  generated: boolean
  request_id: string
  file_document_id: string | null
  download_url: string | null
  arenden: Array<{ personnummer_last4: string }>
  warnings: string[]
  xml?: unknown
}

describe('gnubok_generate_rot_rut_file: the file reaches the user, not the model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListCandidates.mockResolvedValue(candidates())
    mockCreateRequest.mockResolvedValue(created())
    mockUploadDocument.mockResolvedValue({ id: DOCUMENT_ID, storage_path: `${USER}/${DOCUMENT_ID}.xml` })
  })

  it('archives the XML and returns a signed link, with no full personnummer in the result', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // file_document_id update

    const result = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult

    expect(result.generated).toBe(true)
    expect(result).not.toHaveProperty('xml')
    expect(JSON.stringify(result)).not.toContain(BUYER_PERSONNUMMER)
    expect(result.arenden[0].personnummer_last4).toBe('2388')
    expect(result.file_document_id).toBe(DOCUMENT_ID)
    expect(result.download_url).toBe('https://example.com/signed')

    // The archived bytes are the file Skatteverket gets, stored as system
    // räkenskapsinformation (no AI extraction), and the begäran names it.
    const [, uploadUser, uploadCompany, file, metadata] = mockUploadDocument.mock.calls[0]
    expect(uploadUser).toBe(USER)
    expect(uploadCompany).toBe(COMPANY)
    expect(new TextDecoder().decode((file as { buffer: ArrayBuffer }).buffer)).toBe(XML)
    expect(metadata).toEqual({ upload_source: 'system' })
    expect(findCalls('rot_rut_payout_requests', 'update')).toEqual([[{ file_document_id: DOCUMENT_ID }]])
    expect(findCalls('rot_rut_payout_requests', 'eq')).toEqual([['id', REQUEST_ID], ['company_id', COMPANY]])
    expect(supabase.storage.from).toHaveBeenCalledWith('documents')
  })

  it('undoes the begäran when the file cannot be archived, so the same call can run again', async () => {
    mockUploadDocument.mockRejectedValue(new Error('storage unavailable'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // delete of the begäran

    await expect(tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)).rejects.toThrow('storage unavailable')

    expect(findCalls('rot_rut_payout_requests', 'delete')).toHaveLength(1)
    expect(findCalls('rot_rut_payout_requests', 'eq')).toEqual([['id', REQUEST_ID], ['company_id', COMPANY]])
  })

  it('still answers without the XML when the link cannot be signed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // file_document_id update
    supabase.storage.from.mockReturnValueOnce({
      createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'sign failed' } }),
    })

    const result = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult

    expect(result.generated).toBe(true)
    expect(result.download_url).toBeNull()
    expect(result.file_document_id).toBe(DOCUMENT_ID)
    expect(result.warnings.join(' ')).toContain('gnubok_get_document_content')
    expect(JSON.stringify(result)).not.toContain(BUYER_PERSONNUMMER)
  })

  it('declares no inline file in its output schema', () => {
    const properties = (tool.outputSchema as { properties: Record<string, unknown> }).properties
    expect(properties).not.toHaveProperty('xml')
    expect(properties).toHaveProperty('download_url')
    expect(properties).toHaveProperty('file_document_id')
  })
})
