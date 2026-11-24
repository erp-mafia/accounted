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
const mockListGronTeknik = vi.fn()
const mockCreateRequest = vi.fn()
const mockUploadDocument = vi.fn()

vi.mock('@/lib/invoices/rot-rut-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/rot-rut-service')>()),
  listRotRutCandidates: (...args: unknown[]) => mockListCandidates(...args),
  listGronTeknikCandidates: (...args: unknown[]) => mockListGronTeknik(...args),
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
  download_headers: Record<string, string>
  download_note?: string
  app_url: string | null
  arenden: Array<{ personnummer_last4: string }>
  warnings: string[]
  xml?: unknown
}

describe('gnubok_generate_rot_rut_file: the file reaches the user, not the model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListCandidates.mockResolvedValue(candidates())
    mockListGronTeknik.mockResolvedValue(candidates())
    mockCreateRequest.mockResolvedValue(created())
    mockUploadDocument.mockResolvedValue({ id: DOCUMENT_ID, storage_path: `documents/${COMPANY}/${USER}/${DOCUMENT_ID}.xml` })
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
    // Not our Storage host: the raw signed URL, with no header to send and no note.
    expect(result.download_url).toBe('https://example.com/signed')
    expect(result.download_headers).toEqual({})
    expect(result).not.toHaveProperty('download_note')

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

  it('makes the grön teknik file from the grön teknik list, with the same masking', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // file_document_id update

    const result = (await tool.execute({ deduction_type: 'gron_teknik' }, COMPANY, USER, supabase as never)) as GeneratedResult & {
      upload_url: string
    }

    expect(mockListGronTeknik).toHaveBeenCalledWith(supabase, COMPANY)
    expect(mockListCandidates).not.toHaveBeenCalled()
    expect(mockCreateRequest).toHaveBeenCalledWith(supabase, COMPANY, USER, expect.objectContaining({ type: 'gron_teknik', invoiceIds: ['inv-1'] }))
    expect(result.generated).toBe(true)
    expect(JSON.stringify(result)).not.toContain(BUYER_PERSONNUMMER)
    expect(result.upload_url).toContain('gronteknik')
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
    expect(result.download_headers).toEqual({})
    // The app link needs no signed URL: the user still reaches the file.
    expect(result.app_url).toMatch(/\/invoices\/rot-rut$/)
    expect(result.file_document_id).toBe(DOCUMENT_ID)
    expect(result.warnings.join(' ')).toContain('gnubok_get_document_content')
    expect(JSON.stringify(result)).not.toContain(BUYER_PERSONNUMMER)
  })

  // CASA 2.1.1: the link is served from the app origin and its signed token
  // travels in download_headers, never in the URL. A browser sends no such
  // header, so the answer says how the file reaches the user instead.
  it('serves the link from the app origin with the token in download_headers, and says how the file reaches the user', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    try {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null }) // file_document_id update
      supabase.storage.from.mockReturnValueOnce({
        createSignedUrl: vi.fn().mockResolvedValue({
          data: {
            signedUrl: `https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/sign/documents/${USER}/${DOCUMENT_ID}.xml?token=tok`,
          },
          error: null,
        }),
      })

      const result = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult

      expect(result.download_url).toBe(`https://app.accounted.se/api/storage/sign/documents/${USER}/${DOCUMENT_ID}.xml`)
      expect(result.download_headers).toEqual({ Authorization: 'Bearer tok' })
      // The link for the user: the page that lists the begäran with Hämta
      // fil, behind their own login, with no token in it.
      expect(result.app_url).toBe('https://app.accounted.se/invoices/rot-rut')
      expect(result.app_url).not.toContain('tok')
      // The note says whose link is whose, and that the agent leaves the file alone.
      expect(result.download_note).toMatch(/^Give the user app_url/)
      expect(result.download_note).toMatch(/Fakturor > Begär utbetalning/)
      expect(result.download_note).toContain('Do not download or read the file yourself: it holds personnummer.')
      expect(result.download_note).toMatch(/download_url with download_headers is for a client.*does not open as a link in a browser/)
      expect(JSON.stringify(result)).not.toContain(BUYER_PERSONNUMMER)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('answers an empty download_headers when nothing is generated', async () => {
    const { supabase } = createQueuedMockSupabase()
    const listed = (await tool.execute({ deduction_type: 'rut', list_only: true }, COMPANY, USER, supabase as never)) as GeneratedResult
    expect([listed.download_url, listed.download_headers, listed.app_url]).toEqual([null, {}, null])

    mockListCandidates.mockResolvedValue({ ok: true, eligible: [], blocked: [], other_type_counts: {} })
    const nothing = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult
    expect([nothing.download_url, nothing.download_headers, nothing.app_url]).toEqual([null, {}, null])
    expect(tool.description).toContain('returns app_url for the user')
  })

  // The begäran row could not be given its file (the link update failed):
  // Hämta fil on the page would have nothing to fetch, so the user is sent
  // to the archived document itself.
  it('points app_url at the archived document when the file could not be linked to its begäran', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    try {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: { message: 'update failed' } }) // file_document_id update

      const result = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult

      expect(result.generated).toBe(true)
      expect(result.app_url).toBe(`https://app.accounted.se/api/documents/${DOCUMENT_ID}/inline?original=1`)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // A self-host that never set NEXT_PUBLIC_APP_URL: the signed link is
  // Storage's own and opens by itself, as before, so there is no note; the
  // app link is the path.
  it('keeps the raw signed link, no note and the path as app_url where the deployment does not know its origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    try {
      const signedUrl = `https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/sign/documents/${USER}/${DOCUMENT_ID}.xml?token=tok`
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null }) // file_document_id update
      supabase.storage.from.mockReturnValueOnce({
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl }, error: null }),
      })

      const result = (await tool.execute({ deduction_type: 'rut' }, COMPANY, USER, supabase as never)) as GeneratedResult

      expect(result.download_url).toBe(signedUrl)
      expect(result.download_headers).toEqual({})
      expect(result).not.toHaveProperty('download_note')
      expect(result.app_url).toBe('/invoices/rot-rut')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('declares no inline file in its output schema', () => {
    const properties = (tool.outputSchema as { properties: Record<string, unknown> }).properties
    expect(properties).not.toHaveProperty('xml')
    expect(properties).toHaveProperty('download_url')
    expect(properties).toHaveProperty('file_document_id')
  })
})
