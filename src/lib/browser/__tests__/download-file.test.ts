import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  downloadFile,
  saveBlobToDisk,
  DOWNLOAD_TIMEOUT_MS,
  OBJECT_URL_REVOKE_DELAY_MS,
} from '@/lib/browser/download-file'

const originalFetch = globalThis.fetch

const EXPORT_BODY = JSON.stringify({ version: 1, templates: [{ name: 'Inköp EU-varor' }] })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A fetch that never resolves and rejects the way the platform does on abort. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        reject(err)
      })
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('downloadFile', () => {
  it('saves the file when the server answers 2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(EXPORT_BODY))
    const saveBlob = vi.fn()

    const result = await downloadFile({
      url: '/api/settings/booking-templates/export',
      filename: 'bokforingsmallar.json',
      saveBlob,
    })

    expect(result).toEqual({ ok: true, filename: 'bokforingsmallar.json' })
    expect(saveBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = saveBlob.mock.calls[0]
    expect(filename).toBe('bokforingsmallar.json')
    await expect((blob as Blob).text()).resolves.toBe(EXPORT_BODY)
  })

  it('GETs by default and POSTs JSON when postJson is given', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(EXPORT_BODY)))
    globalThis.fetch = fetchMock
    const saveBlob = vi.fn()

    await downloadFile({ url: '/a', filename: 'a.xml', saveBlob })
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET')

    await downloadFile({ url: '/b', filename: 'b.xml', saveBlob, postJson: { confirm_previous_not_approved: true } })
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.body).toBe('{"confirm_previous_not_approved":true}')
    expect(saveBlob).toHaveBeenCalledTimes(2)
  })

  it('writes NO file on a 500 and reports the envelope message', async () => {
    // The regression guard. The old handler called res.blob() with no res.ok
    // check, so this error envelope was saved to disk as bokforingsmallar.json
    // and the download was reported as a success.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Kunde inte hämta mallarna. Försök igen.',
            message_en: 'Could not load the templates. Please try again.',
          },
        },
        500,
      ),
    )
    const saveBlob = vi.fn()

    const result = await downloadFile({
      url: '/api/settings/booking-templates/export',
      filename: 'bokforingsmallar.json',
      saveBlob,
    })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 500,
      message: 'Kunde inte hämta mallarna. Försök igen.',
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Kunde inte hämta mallarna. Försök igen.',
          message_en: 'Could not load the templates. Please try again.',
        },
      },
    })
  })

  it('falls back to the status message when the error body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    const saveBlob = vi.fn()

    const result = await downloadFile({ url: '/x', filename: 'f.json', saveBlob })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 502,
      message: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
      body: null,
    })
  })

  it('reports a server error in English for an English UI', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Ett oväntat serverfel uppstod.' } }, 500),
    )
    const saveBlob = vi.fn()

    const result = await downloadFile({
      url: '/x',
      filename: 'f.json',
      locale: 'en',
      saveBlob,
    })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, reason: 'server', message: 'Internal server error.' })
  })

  it('writes NO file when the request throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const saveBlob = vi.fn()

    const result = await downloadFile({ url: '/x', filename: 'f.json', saveBlob })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen, och kontakta support om det fortsätter.',
    })
  })

  it('writes NO file when the body is truncated mid-read', async () => {
    const res = new Response(EXPORT_BODY, { status: 200 })
    vi.spyOn(res, 'blob').mockRejectedValue(new TypeError('network error'))
    globalThis.fetch = vi.fn().mockResolvedValue(res)
    const saveBlob = vi.fn()

    const result = await downloadFile({ url: '/x', filename: 'f.json', saveBlob })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, reason: 'network' })
  })

  it('reports a hung request as a timeout, not as a generic failure', async () => {
    globalThis.fetch = hangingFetch()
    const saveBlob = vi.fn()

    const result = await downloadFile({
      url: '/x',
      filename: 'f.json',
      timeoutMs: 20,
      saveBlob,
    })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    // The call site branches on this to say "took too long" instead of the
    // generic "something went wrong".
    expect(result).not.toMatchObject({ reason: 'network' })
  })

  it('saves under the server-given name when asked to, decoding the UTF-8 form', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('PK', {
        status: 200,
        headers: {
          'Content-Disposition': `attachment; filename="L_nespec.zip"; filename*=UTF-8''L%C3%B6nespec.zip`,
        },
      }),
    )
    const saveBlob = vi.fn()

    const result = await downloadFile({
      url: '/x',
      filename: 'fallback.zip',
      preferServerFilename: true,
      saveBlob,
    })

    expect(result).toEqual({ ok: true, filename: 'Lönespec.zip' })
    expect(saveBlob.mock.calls[0][1]).toBe('Lönespec.zip')
  })

  it('keeps the given name when the response names none, or when not asked', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('PK', { status: 200 }))
    const saveBlob = vi.fn()

    const result = await downloadFile({ url: '/x', filename: 'fallback.zip', preferServerFilename: true, saveBlob })
    expect(result).toEqual({ ok: true, filename: 'fallback.zip' })

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('PK', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="server.zip"' } }),
    )
    const fixed = await downloadFile({ url: '/x', filename: 'mine.zip', saveBlob })
    expect(fixed).toEqual({ ok: true, filename: 'mine.zip' })
  })

  it('reads a refusal in the caller\'s context and hands back the envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 418 }))

    const result = await downloadFile({ url: '/x', filename: 'f.pdf', errorContext: 'invoice', saveBlob: vi.fn() })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 418,
      message: 'Kunde inte hantera fakturan. Försök igen.',
      body: null,
    })
  })

  it('passes the deadline to fetch as an abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(EXPORT_BODY))
    globalThis.fetch = fetchMock

    await downloadFile({ url: '/x', filename: 'f.json', saveBlob: vi.fn() })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(DOWNLOAD_TIMEOUT_MS).toBe(15_000)
  })
})

describe('saveBlobToDisk', () => {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  function stubDom() {
    const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() }
    const body = { appendChild: vi.fn() }
    ;(globalThis as Record<string, unknown>).document = {
      createElement: vi.fn(() => anchor),
      body,
    }
    const createObjectURL = vi.fn(() => 'blob:test-url')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL
    return { anchor, body, revokeObjectURL }
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    vi.useRealTimers()
  })

  it('defers object-URL revocation so the browser can finish reading the blob', () => {
    // Revoking synchronously in a finally right after a.click() can abort the
    // save in Firefox/Safari: the click only STARTS the download.
    vi.useFakeTimers()
    const { anchor, revokeObjectURL } = stubDom()

    saveBlobToDisk(new Blob(['x']), 'f.json')

    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(OBJECT_URL_REVOKE_DELAY_MS - 1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
  })

  it('revokes immediately when the click never happened', () => {
    // Nothing is reading the URL if the DOM threw before the click, so the
    // blob memory is released right away instead of leaking for 10 seconds.
    vi.useFakeTimers()
    const { body, revokeObjectURL } = stubDom()
    body.appendChild.mockImplementation(() => {
      throw new Error('detached document')
    })

    expect(() => saveBlobToDisk(new Blob(['x']), 'f.json')).toThrow('detached document')
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
  })
})
