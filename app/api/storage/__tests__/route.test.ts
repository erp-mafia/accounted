import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SUPABASE = 'https://pwxtzglxptnnvjrpixpg.supabase.co'
const OPAQUE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"

const fetchMock = vi.fn()

// document_attachments lookup behind a proxied download: (table, columns,
// filter column, filter value) => { data, error }.
const documentLookup = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => ({
          limit: () => documentLookup(table, columns, column, value),
        }),
      }),
    }),
  }),
}))

import { GET, HEAD, OPTIONS, PUT } from '../[...path]/route'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  documentLookup.mockReset()
  documentLookup.mockResolvedValue({ data: [], error: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function upstreamResponse(body: string | null, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-length': String(body?.length ?? 0) },
    ...init,
  })
}

function pdfRow(fileName = 'kvitto.pdf', mimeType: string | null = 'application/pdf') {
  return { data: [{ mime_type: mimeType, file_name: fileName }], error: null }
}

describe('/api/storage/[...path] same-origin Storage proxy', () => {
  it('forwards a signed upload PUT (bytes, content-type, token) to our Storage host', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ Key: 'documents/x' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const bytes = new TextEncoder().encode('%PDF-1.4 hello')
    const request = new Request(
      'https://app.accounted.se/api/storage/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig',
      { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes },
    )

    const response = await PUT(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    // Storage's own JSON envelope, not object bytes: relayed as-is.
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(documentLookup).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=eyJ.sig`,
    )
    expect(init.method).toBe('PUT')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBe('application/pdf')
    expect(headers.get('x-upsert')).toBe('false')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('%PDF-1.4 hello')
  })

  it('streams a signed download GET and serves the DB-validated type when it is inline-safe', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('%PDF-1.4 bytes', {
        headers: {
          'content-type': 'text/html',
          'content-disposition': 'inline; filename="evil.html"',
          'set-cookie': 'leak=1',
          'etag': '"abc"',
        },
      }),
    )
    documentLookup.mockResolvedValue(pdfRow('kvitto.pdf'))
    const request = new Request(
      'https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig',
    )

    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('%PDF-1.4 bytes')
    // The upstream (uploader-declared) type and disposition are ignored; the
    // document row decides, and its filename is what the browser sees.
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe(
      `inline; filename="kvitto.pdf"; filename*=UTF-8''kvitto.pdf`,
    )
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('etag')).toBe('"abc"')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(documentLookup).toHaveBeenCalledWith(
      'document_attachments',
      'mime_type, file_name',
      'storage_path',
      'co-1/user-1/kvitto.pdf',
    )
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig`)
    expect(init.method).toBe('GET')
  })

  it('looks the document up by its percent-decoded key and tolerates legacy type spelling', async () => {
    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    documentLookup.mockResolvedValue(pdfRow('kvitto maj.pdf', 'Application/PDF; charset=binary'))

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto%20maj.pdf?token=t'),
    )

    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(documentLookup).toHaveBeenCalledWith(
      'document_attachments',
      'mime_type, file_name',
      'storage_path',
      'co-1/user-1/kvitto maj.pdf',
    )
  })

  it("honours Storage's ?download convention for an inline-safe type", async () => {
    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    documentLookup.mockResolvedValue(pdfRow('kvitto.pdf'))

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=t&download='),
    )

    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="kvitto.pdf"')

    const named = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=t&download=mars.pdf'),
    )
    expect(named.headers.get('content-disposition')).toContain('attachment; filename="mars.pdf"')
  })

  it('serves a document whose stored type is active content as an opaque attachment', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('<script>alert(document.cookie)</script>', {
        headers: { 'content-type': 'text/html', 'content-disposition': 'inline; filename="mail.html"' },
      }),
    )
    documentLookup.mockResolvedValue(pdfRow('mail.html', 'text/html'))

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/mail.html?token=t'),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<script>alert(document.cookie)</script>')
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="mail.html"; filename*=UTF-8''mail.html`,
    )
    expect(response.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each(['image/svg+xml', 'application/xml', 'application/xhtml+xml', 'application/json'])(
    'never serves %s from the proxy with its own type',
    async (mimeType) => {
      fetchMock.mockResolvedValue(upstreamResponse('<x/>', { headers: { 'content-type': mimeType } }))
      documentLookup.mockResolvedValue(pdfRow('underlag', mimeType))

      const response = await GET(
        new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/underlag?token=t'),
      )

      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('content-disposition')).toContain('attachment')
      expect(response.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
    },
  )

  it('serves an object without a document row (audit-package zip) as an opaque attachment named after its key', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('PK...', {
        headers: { 'content-type': 'text/html', 'content-disposition': 'inline; filename="x.html"' },
      }),
    )
    documentLookup.mockResolvedValue({ data: [], error: null })

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/user-1/audit-packages/1700_audit%202026.zip?token=t'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="1700_audit 2026.zip"; filename*=UTF-8''1700_audit%202026.zip`,
    )
    expect(response.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
  })

  it('fails closed to the opaque default when the document lookup errors or throws', async () => {
    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))

    documentLookup.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const errored = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=t'),
    )
    expect(errored.status).toBe(200)
    expect(errored.headers.get('content-type')).toBe('application/octet-stream')
    expect(errored.headers.get('content-security-policy')).toBe(OPAQUE_CSP)

    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    documentLookup.mockRejectedValue(new Error('network'))
    const thrown = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=t'),
    )
    expect(thrown.status).toBe(200)
    expect(thrown.headers.get('content-type')).toBe('application/octet-stream')
    expect(thrown.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
  })

  it('does not consult the database when Storage rejects the token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: '400', error: 'InvalidJWT' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=bad'),
    )

    expect(response.status).toBe(400)
    expect(documentLookup).not.toHaveBeenCalled()
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
  })

  it('answers HEAD without a body and with the same served headers as GET', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(null, { headers: { 'content-type': 'text/html', 'content-length': '14' } }))
    documentLookup.mockResolvedValue(pdfRow('kvitto.pdf'))

    const response = await HEAD(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=t', { method: 'HEAD' }),
    )

    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-length')).toBe('14')
    expect(response.headers.get('content-security-policy')).toBeNull()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('HEAD')
  })

  it('answers HEAD without a body and relays the upstream status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404, headers: { 'content-type': 'application/json' } }))

    const response = await HEAD(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/missing.pdf?token=t', { method: 'HEAD' }),
    )

    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
    expect(documentLookup).not.toHaveBeenCalled()
  })

  it('refuses paths outside the signed documents-bucket allowlist without touching Storage', async () => {
    const response = await GET(
      new Request('https://app.accounted.se/api/storage/public/documents/a.pdf?token=t'),
    )

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('STORAGE_PROXY_UNSUPPORTED_PATH')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a link without its signed token', async () => {
    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/a.pdf'),
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('STORAGE_PROXY_TOKEN_REQUIRED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized upload before forwarding it', async () => {
    const request = new Request(
      'https://app.accounted.se/api/storage/upload/sign/documents/co-1/big.pdf?token=t',
      { method: 'PUT', headers: { 'content-length': String(51 * 1024 * 1024) }, body: 'x' },
    )

    const response = await PUT(request)

    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized upload that lies about (or omits) its content-length, without buffering it all', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const request = new Request(
      'https://app.accounted.se/api/storage/upload/sign/documents/co-1/big.pdf?token=t',
      { method: 'PUT', body: endless, duplex: 'half' } as RequestInit,
    )

    const response = await PUT(request)

    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(pulled).toBeLessThan(60)
  })

  it('reports Storage being unreachable as 502 instead of crashing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const response = await GET(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/a.pdf?token=t'),
    )

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('STORAGE_PROXY_UPSTREAM_UNAVAILABLE')
  })

  it('answers CORS preflight', async () => {
    const response = await OPTIONS()
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT')
  })
})
