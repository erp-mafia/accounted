import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, HEAD, OPTIONS, PUT } from '../[...path]/route'

const SUPABASE = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
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

  it('streams a signed download GET through and keeps the document headers', async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse('%PDF-1.4 bytes', {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="kvitto.pdf"',
          'set-cookie': 'leak=1',
        },
      }),
    )
    const request = new Request(
      'https://app.accounted.se/api/storage/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig',
    )

    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('%PDF-1.4 bytes')
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="kvitto.pdf"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('set-cookie')).toBeNull()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SUPABASE}/storage/v1/object/sign/documents/co-1/user-1/kvitto.pdf?token=eyJ.sig`)
    expect(init.method).toBe('GET')
  })

  it('answers HEAD without a body and relays the upstream status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404, headers: { 'content-type': 'application/json' } }))

    const response = await HEAD(
      new Request('https://app.accounted.se/api/storage/sign/documents/co-1/missing.pdf?token=t', { method: 'HEAD' }),
    )

    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
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
