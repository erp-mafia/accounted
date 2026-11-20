/**
 * gnubok_get_invoice_pdf (crm#1593): an agent asked to save sent invoices'
 * PDFs had no way to the file. The tool follows the dashboard download's
 * rule (lib/invoices/invoice-pdf-source.ts): the archived copy of an email
 * delivery when Accounted sent the invoice, else a fresh render through the
 * v1 download's loader. Either way the agent gets a signed URL, never bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { ALL_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

const { mockRenderStored } = vi.hoisted(() => ({ mockRenderStored: vi.fn() }))
vi.mock('@/lib/invoices/stored-invoice-pdf', () => ({ renderStoredInvoicePdf: mockRenderStored }))

import { tools } from '../server'
import { isDefaultCatalogTool } from '../tool-reach'

const tool = tools.find((t) => t.name === 'gnubok_get_invoice_pdf')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DELIVERY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DOCUMENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const run = (supabase: unknown, args: Record<string, unknown> = { invoice_id: INVOICE_ID }) =>
  tool.execute(args, COMPANY_ID, USER_ID, supabase as never, { type: 'api_key' } as never) as Promise<
    Record<string, unknown>
  >

function storageOf(supabase: { storage: { from: ReturnType<typeof vi.fn> } }) {
  return supabase.storage.from.mock.results[0]?.value as
    | { upload: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn> }
    | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('gnubok_get_invoice_pdf: registration', () => {
  it('is a search-only read under invoices:read, taking only invoice_id', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations.readOnlyHint).toBe(true)
    expect(isDefaultCatalogTool(tool)).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_get_invoice_pdf).toBe('invoices:read')
    const schema = tool.inputSchema as { additionalProperties: boolean; required: string[] }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['invoice_id'])
  })
})

describe('gnubok_get_invoice_pdf: found by the words the reporting agent used', () => {
  it.each(['invoice pdf', 'download invoice PDF', 'faktura pdf'])('"%s" ranks it first, reachable through gnubok_call_tool', async (query) => {
    const search = tools.find((t) => t.name === 'gnubok_search_tools')!
    const result = (await search.execute(
      { query, limit: 3, __keyScopes: ALL_SCOPES },
      COMPANY_ID,
      USER_ID,
      {} as never,
      { type: 'api_key' } as never,
    )) as { tools: Array<{ name: string; callable_via?: string }> }
    expect(result.tools[0]).toMatchObject({ name: 'gnubok_get_invoice_pdf', callable_via: 'call_tool' })
  })
})

describe('gnubok_get_invoice_pdf: execute', () => {
  it('refuses an id that is not a UUID before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(run(supabase, { invoice_id: '351' })).rejects.toThrow(/UUID/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers NOT_FOUND for an invoice outside the routed company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(run(supabase)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockRenderStored).not.toHaveBeenCalled()
  })

  it('an emailed invoice gets the archived file the customer received, signed, never re-rendered', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'sent', invoice_number: '1042' } })
    enqueue({
      data: [{ id: DELIVERY_ID, status: 'sent', document_attachment_id: DOCUMENT_ID, sent_at: '2026-10-01T09:00:00Z' }],
    })
    enqueue({
      data: { id: DOCUMENT_ID, file_name: 'Faktura 1042.pdf', storage_path: `documents/${COMPANY_ID}/inv.pdf`, file_size_bytes: 2048 },
    })

    const result = await run(supabase)

    expect(result).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: '1042',
      file_name: 'Faktura 1042.pdf',
      source: 'archived',
      reason: null,
      document_id: DOCUMENT_ID,
      size_bytes: 2048,
      // Not our Storage host: the raw signed URL, with no header to send.
      signed_url: 'https://example.com/signed',
      signed_url_headers: {},
      // For the user: the session route of exactly this delivery's archived file.
      app_url: `https://app.accounted.se/api/invoices/${INVOICE_ID}/archived-pdf?delivery=${DELIVERY_ID}`,
    })
    expect(typeof result.expires_at).toBe('string')
    expect(supabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries_for_service', {
      p_company_id: COMPANY_ID,
      p_user_id: USER_ID,
      p_invoice_id: INVOICE_ID,
    })
    const storage = storageOf(supabase)!
    expect(storage.createSignedUrl).toHaveBeenCalledWith(`documents/${COMPANY_ID}/inv.pdf`, 3600)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(mockRenderStored).not.toHaveBeenCalled()
  })

  it('an invoice marked sent outside Accounted is rendered, stored on one path per invoice and labelled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'sent', invoice_number: '351' } })
    enqueue({ data: [{ id: DELIVERY_ID, status: 'marked_sent', document_attachment_id: null, sent_at: '2026-10-01T09:00:00Z' }] })
    mockRenderStored.mockResolvedValue({ ok: true, buffer: Buffer.from('%PDF-1.7'), filename: 'Faktura 351.pdf', invoice: {} })

    const result = await run(supabase)

    expect(mockRenderStored).toHaveBeenCalledWith(supabase, COMPANY_ID, INVOICE_ID, expect.anything())
    expect(result).toMatchObject({
      file_name: 'Faktura 351.pdf',
      source: 'rendered',
      reason: 'sent_outside_accounted',
      document_id: null,
      size_bytes: 8,
      signed_url: 'https://example.com/signed',
    })
    const storage = storageOf(supabase)!
    const path = `${USER_ID}/invoice-pdfs/${INVOICE_ID}.pdf`
    expect(storage.upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: true })
    expect(storage.createSignedUrl).toHaveBeenCalledWith(path, 3600)
  })

  // CASA 2.1.1: served from the app origin, the signed token travels in
  // signed_url_headers and never in the URL.
  it('serves the PDF from the app origin with the token in signed_url_headers, not in the URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    try {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: INVOICE_ID, status: 'draft', invoice_number: null } })
      enqueue({ data: [] })
      mockRenderStored.mockResolvedValue({ ok: true, buffer: Buffer.from('%PDF'), filename: 'utkast.pdf', invoice: {} })
      const path = `${USER_ID}/invoice-pdfs/${INVOICE_ID}.pdf`
      supabase.storage.from.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: `https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/sign/documents/${path}?token=tok` },
          error: null,
        }),
      })

      const result = await run(supabase)

      expect(result.signed_url).toBe(`https://app.accounted.se/api/storage/sign/documents/${path}`)
      expect(result.signed_url_headers).toEqual({ Authorization: 'Bearer tok' })
      expect(tool.description).toContain('signed_url_headers')
      expect((tool.outputSchema as { required: string[] }).required).toContain('signed_url_headers')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // The signed link answers 400 in a browser (its token is in a header), so
  // the answer also carries the link a user can click: the session route.
  it('a rendered invoice gets an app_url the user opens signed in: the session render, on the app origin, with no token', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pwxtzglxptnnvjrpixpg.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'draft', invoice_number: null } })
    enqueue({ data: [] })
    mockRenderStored.mockResolvedValue({ ok: true, buffer: Buffer.from('%PDF'), filename: 'utkast.pdf', invoice: {} })
    supabase.storage.from.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: `https://pwxtzglxptnnvjrpixpg.supabase.co/storage/v1/object/sign/documents/${USER_ID}/invoice-pdfs/${INVOICE_ID}.pdf?token=tok` },
        error: null,
      }),
    })

    const result = await run(supabase)

    expect(result.app_url).toBe(`https://app.accounted.se/api/invoices/${INVOICE_ID}/pdf?disposition=inline`)
    expect(result.app_url).not.toContain('tok')
    expect(result.signed_url).not.toContain('tok')
    expect(tool.description).toContain('app_url')
    expect((tool.outputSchema as { required: string[] }).required).toContain('app_url')
  })

  it('answers the path as app_url on a deployment that does not know its origin, beside the raw signed link', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'draft', invoice_number: null } })
    enqueue({ data: [] })
    mockRenderStored.mockResolvedValue({ ok: true, buffer: Buffer.from('%PDF'), filename: 'utkast.pdf', invoice: {} })

    const result = await run(supabase)

    expect(result.app_url).toBe(`/api/invoices/${INVOICE_ID}/pdf?disposition=inline`)
    expect(result).toMatchObject({ signed_url: 'https://example.com/signed', signed_url_headers: {} })
  })

  it('a draft is rendered as not sent yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'draft', invoice_number: null } })
    enqueue({ data: [] })
    mockRenderStored.mockResolvedValue({ ok: true, buffer: Buffer.from('%PDF'), filename: 'utkast.pdf', invoice: {} })

    expect(await run(supabase)).toMatchObject({ source: 'rendered', reason: 'not_sent_yet', invoice_number: null })
  })

  it('a sent invoice whose delivery history cannot be read is an error, never a re-render passed off as the sent file', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'sent', invoice_number: '1042' } })
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    await expect(run(supabase)).rejects.toThrow()
    expect(mockRenderStored).not.toHaveBeenCalled()
  })

  it('a render refusal keeps its code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: INVOICE_ID, status: 'draft', invoice_number: null } })
    enqueue({ data: [] })
    mockRenderStored.mockResolvedValue({ ok: false, code: 'INVOICE_CUSTOMER_MISSING' })

    await expect(run(supabase)).rejects.toMatchObject({ code: 'INVOICE_CUSTOMER_MISSING' })
    expect(storageOf(supabase)).toBeUndefined()
  })
})
