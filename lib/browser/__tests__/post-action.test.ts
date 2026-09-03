import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { postAction, POST_ACTION_TIMEOUT_MS } from '@/lib/browser/post-action'

const originalFetch = globalThis.fetch

const MARK_PAID_URL = '/api/skatteverket/tax-payments/2026-04/mark-paid'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
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

describe('postAction', () => {
  it('reports success on 2xx without reading the body', async () => {
    const res = jsonResponse({ data: { ok: true } })
    const jsonSpy = vi.spyOn(res, 'json')
    globalThis.fetch = vi.fn().mockResolvedValue(res)

    const result = await postAction({ url: MARK_PAID_URL })

    expect(result).toEqual({ ok: true })
    // The success shape is the route's business, not the button's.
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('sends POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    globalThis.fetch = fetchMock

    await postAction({ url: MARK_PAID_URL })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
  })

  it('reports the envelope message on 404', async () => {
    // The regression guard for the missing catch: this used to be the only
    // branch that spoke to the user at all.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Ingen AGI för perioden 2026-04.' }, 404))

    const result = await postAction({ url: MARK_PAID_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 404,
      // The route's own Swedish sentence is shown as-is (issue #2086): it
      // used to be dropped for lacking one of getErrorMessage's keywords and
      // replaced by the status map's "Resursen kunde inte hittas.".
      message: 'Ingen AGI för perioden 2026-04.',
    })
  })

  it('keeps a Swedish server message verbatim', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Kunde inte markera som betald. Försök igen.' }, 500))

    const result = await postAction({ url: MARK_PAID_URL })

    expect(result).toMatchObject({
      reason: 'server',
      status: 500,
      message: 'Kunde inte markera som betald. Försök igen.',
    })
  })

  it('falls back to the status message when the error body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await postAction({ url: MARK_PAID_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'server',
      status: 502,
      message: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
    })
  })

  it('reports a server error in English for an English UI', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Serverfel' } }, 500))

    const result = await postAction({ url: MARK_PAID_URL, locale: 'en' })

    expect(result).toMatchObject({ reason: 'server', message: 'Internal server error.' })
  })

  it('reports a thrown request as a network failure, not as success', async () => {
    // The finding: with try/finally and no catch this rejection escaped as an
    // unhandled rejection and the user was told nothing at all.
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const result = await postAction({ url: MARK_PAID_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen.',
    })
  })

  it('reports a hung request as a timeout, not as a generic failure', async () => {
    globalThis.fetch = hangingFetch()

    const result = await postAction({ url: MARK_PAID_URL, timeoutMs: 20 })

    // A timeout on a write is ambiguous (the update may have landed), so the
    // call site needs to tell it apart to say "reload and check".
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('bounds the request with an abort signal on the default deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    globalThis.fetch = fetchMock

    await postAction({ url: MARK_PAID_URL })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Never shorter than the download deadline: aborting a mutation early
    // reports a failure for a write that may have landed.
    expect(POST_ACTION_TIMEOUT_MS).toBe(15_000)
  })
})
