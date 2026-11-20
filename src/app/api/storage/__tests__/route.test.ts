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
import { registerObservabilitySink, resetObservabilitySink } from '@/lib/observability/sink'

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

const APP_STORAGE = 'https://app.accounted.se/api/storage'
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJkb2N1bWVudHMveCJ9.c2ln'

/** A request as the MCP tools tell a client to make it: no token in the URL, the token in the Authorization header. */
function signedRequest(pathAndQuery: string, init: RequestInit = {}, token: string = TOKEN): Request {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(`${APP_STORAGE}/${pathAndQuery}`, { ...init, headers })
}

/** Every header and, unless the test already read it, the body of a response: where a leaked token would show. */
async function everythingSentBack(response: Response): Promise<string> {
  const headers = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n')
  return `${headers}\n${response.bodyUsed ? '' : await response.clone().text()}`
}

describe('/api/storage/[...path] same-origin Storage proxy', () => {
  it('forwards a signed upload PUT (bytes, content-type, header token) to our Storage host', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ Key: 'documents/x' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const bytes = new TextEncoder().encode('%PDF-1.4 hello')
    const request = signedRequest(
      'upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf',
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
    // Server to server, the token goes where Storage reads it: its query.
    expect(url).toBe(
      `${SUPABASE}/storage/v1/object/upload/sign/documents/co-1/user-1/pending/up-1/faktura%20maj.pdf?token=${TOKEN}`,
    )
    expect(init.method).toBe('PUT')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBe('application/pdf')
    expect(headers.get('x-upsert')).toBe('false')
    // The client's Authorization header is the proxy's credential, not Storage's.
    expect(headers.get('authorization')).toBeNull()
    expect(await everythingSentBack(response)).not.toContain(TOKEN)
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
    const request = signedRequest('sign/documents/co-1/user-1/kvitto.pdf')

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
    expect(url).toBe(`${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=${TOKEN}`)
    expect(init.method).toBe('GET')
    expect((init.headers as Headers).get('authorization')).toBeNull()
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await everythingSentBack(response)).not.toContain(TOKEN)
  })

  it('looks the document up by its percent-decoded key and tolerates legacy type spelling', async () => {
    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    documentLookup.mockResolvedValue(pdfRow('kvitto maj.pdf', 'Application/PDF; charset=binary'))

    const response = await GET(signedRequest('sign/documents/co-1/user-1/kvitto%20maj.pdf'))

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

    const response = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf?download='))

    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="kvitto.pdf"')

    const named = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf?download=mars.pdf'))
    expect(named.headers.get('content-disposition')).toContain('attachment; filename="mars.pdf"')
    // The parameter travels on to Storage beside the header token.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=${TOKEN}&download=`,
      `${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=${TOKEN}&download=mars.pdf`,
    ])
  })

  it('serves a document whose stored type is active content as an opaque attachment', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('<script>alert(document.cookie)</script>', {
        headers: { 'content-type': 'text/html', 'content-disposition': 'inline; filename="mail.html"' },
      }),
    )
    documentLookup.mockResolvedValue(pdfRow('mail.html', 'text/html'))

    const response = await GET(signedRequest('sign/documents/co-1/user-1/mail.html'))

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

      const response = await GET(signedRequest('sign/documents/co-1/user-1/underlag'))

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

    const response = await GET(signedRequest('sign/documents/user-1/audit-packages/1700_audit%202026.zip'))

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
    const errored = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf'))
    expect(errored.status).toBe(200)
    expect(errored.headers.get('content-type')).toBe('application/octet-stream')
    expect(errored.headers.get('content-security-policy')).toBe(OPAQUE_CSP)

    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    documentLookup.mockRejectedValue(new Error('network'))
    const thrown = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf'))
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

    const response = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf'))

    expect(response.status).toBe(400)
    expect(documentLookup).not.toHaveBeenCalled()
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-security-policy')).toBe(OPAQUE_CSP)
  })

  it('answers HEAD without a body and with the same served headers as GET', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(null, { headers: { 'content-type': 'text/html', 'content-length': '14' } }))
    documentLookup.mockResolvedValue(pdfRow('kvitto.pdf'))

    const response = await HEAD(signedRequest('sign/documents/co-1/user-1/kvitto.pdf', { method: 'HEAD' }))

    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-length')).toBe('14')
    expect(response.headers.get('content-security-policy')).toBeNull()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=${TOKEN}`)
    expect(init.method).toBe('HEAD')
    expect(await everythingSentBack(response)).not.toContain(TOKEN)
  })

  it('answers HEAD without a body and relays the upstream status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404, headers: { 'content-type': 'application/json' } }))

    const response = await HEAD(signedRequest('sign/documents/co-1/missing.pdf', { method: 'HEAD' }))

    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
    expect(documentLookup).not.toHaveBeenCalled()
  })

  it('refuses paths outside the signed documents-bucket allowlist without touching Storage', async () => {
    const response = await GET(signedRequest('public/documents/a.pdf'))

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('STORAGE_PROXY_UNSUPPORTED_PATH')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a request without its signed token, on every method', async () => {
    const path = `${APP_STORAGE}/sign/documents/co-1/a.pdf`
    const uploadPath = `${APP_STORAGE}/upload/sign/documents/co-1/a.pdf`
    const responses = [
      await GET(new Request(path)),
      await HEAD(new Request(path, { method: 'HEAD' })),
      await PUT(new Request(uploadPath, { method: 'PUT', body: 'x' })),
      // Not a Bearer credential: as good as none.
      await GET(new Request(path, { headers: { authorization: `Basic ${TOKEN}` } })),
    ]

    for (const response of responses) {
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string; message_en: string } }
      expect(body.error.code).toBe('STORAGE_PROXY_TOKEN_REQUIRED')
      expect(body.error.message_en).toContain('Authorization: Bearer')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // CASA 2.1.1: no credential in a URL this application serves.
  it('refuses a token in the query string on every method, with or without the header, and forwards nothing', async () => {
    const download = `sign/documents/co-1/a.pdf?token=${TOKEN}`
    const upload = `upload/sign/documents/co-1/a.pdf?token=${TOKEN}`
    const tokenInUrlUpload = new Request(`${APP_STORAGE}/${upload}`, { method: 'PUT', body: 'x' })
    const responses = [
      await GET(new Request(`${APP_STORAGE}/${download}`)),
      await HEAD(new Request(`${APP_STORAGE}/${download}`, { method: 'HEAD' })),
      await PUT(tokenInUrlUpload),
      // The header does not excuse the URL.
      await GET(signedRequest(download)),
      await GET(signedRequest(`sign/documents/co-1/a.pdf?download=a.pdf&token=${TOKEN}`)),
      await PUT(signedRequest(upload, { method: 'PUT', body: 'x' })),
      // An empty value is still the parameter.
      await GET(signedRequest('sign/documents/co-1/a.pdf?token=')),
    ]

    for (const response of responses) {
      expect(response.status).toBe(400)
      const sent = await everythingSentBack(response)
      expect(sent).not.toContain(TOKEN)
      const body = JSON.parse(await response.text()) as { error: { code: string; message_en: string } }
      expect(body.error.code).toBe('STORAGE_PROXY_TOKEN_IN_URL')
      expect(body.error.message_en).toContain('Authorization: Bearer')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    // Refused before the upload body is read.
    expect(tokenInUrlUpload.bodyUsed).toBe(false)
  })

  it('refuses an Accounted API key sent as the token instead of relaying it to Storage', async () => {
    const apiKey = 'gnubok_sk_Zm9vYmFyYmF6cXV4'
    const response = await GET(signedRequest('sign/documents/co-1/a.pdf', {}, apiKey))

    expect(response.status).toBe(400)
    const sent = await everythingSentBack(response)
    expect(sent).not.toContain(apiKey)
    expect((JSON.parse(await response.text()) as { error: { code: string } }).error.code).toBe(
      'STORAGE_PROXY_API_KEY_REFUSED',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never hands the token back: not in a relayed redirect, not in any header or error body', async () => {
    // Storage answering with a redirect to its own signed URL: not followed, and its Location is not relayed.
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: `${SUPABASE}/storage/v1/object/sign/documents/co-1/a.pdf?token=${TOKEN}`,
          'content-location': `/object/sign/documents/co-1/a.pdf?token=${TOKEN}`,
          link: `<${SUPABASE}/x?token=${TOKEN}>; rel="canonical"`,
        },
      }),
    )
    const redirected = await GET(signedRequest('sign/documents/co-1/a.pdf'))
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBeNull()
    expect(await everythingSentBack(redirected)).not.toContain(TOKEN)
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual')

    // Storage refusing the token in its own words.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: '400', error: 'InvalidJWT', message: 'jwt expired' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const refused = await PUT(signedRequest('upload/sign/documents/co-1/a.pdf', { method: 'PUT', body: 'x' }))
    expect(refused.status).toBe(400)
    expect(await everythingSentBack(refused)).not.toContain(TOKEN)
  })

  it('logs an upstream failure without the token, even when the error quotes the URL', async () => {
    const reported: string[] = []
    registerObservabilitySink({
      name: 'test',
      captureException: (error, context) => {
        reported.push(`${(error as Error).name}: ${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(context)}`)
      },
      captureMessage: (message, _level, context) => {
        reported.push(`${message}\n${JSON.stringify(context)}`)
      },
      flush: async () => true,
    })
    try {
      fetchMock.mockImplementation(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`, { cause: new Error(`connect to ${url}`) })
      })

      const response = await GET(signedRequest('sign/documents/co-1/a.pdf'))

      expect(response.status).toBe(502)
      expect(await everythingSentBack(response)).not.toContain(TOKEN)
      expect(reported.length).toBeGreaterThan(0)
      expect(reported.join('\n')).not.toContain(TOKEN)
      expect(reported.join('\n')).toContain('[token]')
    } finally {
      resetObservabilitySink()
    }
  })

  it('rejects an oversized upload before forwarding it', async () => {
    const request = signedRequest('upload/sign/documents/co-1/big.pdf', {
      method: 'PUT',
      headers: { 'content-length': String(51 * 1024 * 1024) },
      body: 'x',
    })

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
    const request = signedRequest('upload/sign/documents/co-1/big.pdf', {
      method: 'PUT',
      body: endless,
      duplex: 'half',
    } as RequestInit)

    const response = await PUT(request)

    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(pulled).toBeLessThan(60)
  })

  it('reports Storage being unreachable as 502 instead of crashing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const response = await GET(signedRequest('sign/documents/co-1/a.pdf'))

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('STORAGE_PROXY_UPSTREAM_UNAVAILABLE')
  })

  it('answers CORS preflight: any origin, the Authorization header allowed, never credentials', async () => {
    const response = await OPTIONS()
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  // The token left the URL, so the URL alone no longer tells two callers
  // apart: a cache keyed on it must never keep a served document.
  it('never lets a cache keep a served document, whatever Storage says about caching', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('%PDF-1.4 bytes', {
        headers: { 'content-type': 'application/pdf', 'cache-control': 'public, max-age=3600', etag: '"abc"' },
      }),
    )
    documentLookup.mockResolvedValue(pdfRow('kvitto.pdf'))

    const served = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf'))
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('private, no-store')
    expect(served.headers.get('vary')).toBe('Authorization')

    const refused = await GET(new Request(`${APP_STORAGE}/sign/documents/co-1/user-1/kvitto.pdf`))
    expect(refused.status).toBe(400)
    expect(refused.headers.get('cache-control')).toBe('private, no-store')
  })

  it('never allows credentials on a served response either', async () => {
    fetchMock.mockResolvedValue(upstreamResponse('%PDF-1.4 bytes'))
    const response = await GET(signedRequest('sign/documents/co-1/user-1/kvitto.pdf'))
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })
})
