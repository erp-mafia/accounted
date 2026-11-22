import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceRoleClient } from '../service-client'
import { gatewayErrorMessage, withShortGatewayErrorPage } from '../gateway-error-page'

// supabase-js resolves a WebSocket when it builds its realtime client; Node 20
// (CI) has none. Nothing here subscribes, so an inert one is enough.
beforeEach(() => {
  if (!('WebSocket' in globalThis)) vi.stubGlobal('WebSocket', class {})
})

const HOST = 'abcdefghijklmnopqrst.supabase.co'

/**
 * Cloudflare's error 1104 page as the database host answered it with HTTP 500
 * for 21 minutes on 2026-11-16, abridged: about 4.7 KB in full. The Ray ID
 * and the time differ on every request, and they are why every request of
 * the outage made a PostHog issue of its own.
 */
function cloudflareScriptNotFound(rayId: string, at: string): Response {
  const page = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head>
<title>Script not found | ${HOST} | Cloudflare</title>
<meta charset="UTF-8" />
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />
<script>
  if (!navigator.cookieEnabled) {
    window.addEventListener('DOMContentLoaded', function () {
      var cookieEl = document.getElementById('cookie-alert');
      cookieEl.style.display = 'block';
    })
  }
</script>
</head>
<body>
    <div id="cf-wrapper">
        <div class="cf-alert cf-alert-error cf-cookie-error" id="cookie-alert" data-translate="enable_cookies">Please enable cookies.</div>
        <div id="cf-error-details" class="cf-error-details-wrapper">
            <div class="cf-wrapper cf-header cf-error-overview">
                <h1>
                    <span class="cf-error-type" data-translate="error">Error</span>
                    <span class="cf-error-code">1104</span>
                    <small class="heading-ray-id">Ray ID: ${rayId} &bull; ${at}</small>
                </h1>
                <h2 class="cf-subheadline" data-translate="error_desc">Script not found</h2>
            </div>
            <div class="cf-error-footer cf-wrapper w-240 lg:w-full py-10 sm:py-4 sm:px-8 mx-auto text-center sm:text-left border-solid border-0 border-t border-gray-300">
                <p class="text-13">
                    <span class="cf-footer-item sm:block sm:mb-1">Cloudflare Ray ID: <strong class="font-semibold">${rayId}</strong></span>
                </p>
            </div>
        </div>
    </div>
</body>
</html>
`
  return new Response(page, {
    status: 500,
    statusText: 'Internal Server Error',
    headers: { 'content-type': 'text/html; charset=UTF-8', 'retry-after': '0' },
  })
}

/** The same page answered with another status (a 503 postgrest-js retries). */
function withStatus(response: Response, status: number): Response {
  return new Response(response.body, { status, headers: response.headers })
}

function clientSendingWith(fetchMock: typeof fetch) {
  return createServiceRoleClient(`https://${HOST}`, 'service-role-key', { global: { fetch: fetchMock } })
}

function clientAnswering(response: () => Response) {
  return clientSendingWith(vi.fn(async () => response()))
}

describe("a server client and a gateway's HTML error page", () => {
  it('reads one short message naming the status and the page, the same for every request of the outage', async () => {
    const first = await clientAnswering(() => cloudflareScriptNotFound('a5b6e815fc10d8e1', '2026-11-16 13:41:58 UTC'))
      .from('companies').select('id').eq('id', 'company-1')
    const second = await clientAnswering(() => cloudflareScriptNotFound('a5b6f2c0d93e41b7', '2026-11-16 13:57:44 UTC'))
      .rpc('get_general_ledger_lines', { p_company_id: 'company-1' })

    expect(first.status).toBe(500)
    expect(first.data).toBeNull()
    expect(first.error?.message).toBe(`Supabase answered HTTP 500 without JSON: Script not found | ${HOST} | Cloudflare`)
    expect(second.error?.message).toBe(first.error?.message)
    expect(`${first.error?.message}`).not.toContain('<')
  })

  it("leaves PostgREST's own JSON error as it is", async () => {
    const { error, status } = await clientAnswering(() => new Response(
      JSON.stringify({ code: 'XX000', details: 'raised in get_general_ledger_lines', hint: null, message: 'internal error' }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )).from('companies').select('id')

    expect(status).toBe(500)
    expect(error).toMatchObject({ code: 'XX000', details: 'raised in get_general_ledger_lines', message: 'internal error' })
  })

  it('still retries a 503 page after its Retry-After, and then reads the short message', async () => {
    const fetchMock = vi.fn(async () => withStatus(cloudflareScriptNotFound('a5b6e815fc10d8e1', '2026-11-16 13:41:58 UTC'), 503))
    const { error, status } = await clientSendingWith(fetchMock).from('companies').select('id')

    // postgrest-js retries a GET answered 503 three times.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(status).toBe(503)
    expect(error?.message).toBe(`Supabase answered HTTP 503 without JSON: Script not found | ${HOST} | Cloudflare`)
  })
})

const REST = `https://${HOST}/rest/v1/companies?select=id`

describe('withShortGatewayErrorPage', () => {
  it('keeps the status and headers, and answers JSON', async () => {
    const send = withShortGatewayErrorPage(vi.fn(async () => cloudflareScriptNotFound('a5b6e815fc10d8e1', '2026-11-16 13:41:58 UTC')))

    const response = await send(REST)

    expect(response.status).toBe(500)
    expect(response.statusText).toBe('Internal Server Error')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    // postgrest-js times its retry of a 503 by it.
    expect(response.headers.get('retry-after')).toBe('0')
    expect(await response.json()).toEqual({ message: `Supabase answered HTTP 500 without JSON: Script not found | ${HOST} | Cloudflare` })
  })

  it("passes a JSON 5xx, an empty 5xx (a HEAD request's), a 4xx page, a 2xx and a request that is not PostgREST's through untouched", async () => {
    const json = new Response('{"code":"XX000","message":"internal error"}', { status: 500 })
    const empty = new Response('', { status: 500 })
    const notFoundPage = new Response('<html><title>404 Not Found</title></html>', { status: 404 })
    const csv = new Response('id\na', { status: 200 })
    const storagePage = cloudflareScriptNotFound('a5b6e815fc10d8e1', '2026-11-16 13:41:58 UTC')
    const base = vi.fn<typeof fetch>()
    base.mockResolvedValueOnce(json).mockResolvedValueOnce(empty).mockResolvedValueOnce(notFoundPage)
      .mockResolvedValueOnce(csv).mockResolvedValueOnce(storagePage)
    const send = withShortGatewayErrorPage(base)

    expect(await send(REST)).toBe(json)
    expect(await send(REST, { method: 'HEAD' })).toBe(empty)
    expect(await send(REST)).toBe(notFoundPage)
    expect(await send(REST)).toBe(csv)
    expect(await send(`https://${HOST}/storage/v1/object/documents/a.pdf`)).toBe(storagePage)
  })

  it('sends with the given fetch, the request unchanged', async () => {
    const base = vi.fn(async () => new Response('[]', { status: 200 }))
    const init = { method: 'GET', headers: { Prefer: 'count=exact' } }

    await withShortGatewayErrorPage(base)(REST, init)

    expect(base).toHaveBeenCalledWith(REST, init)
  })
})

describe('gatewayErrorMessage', () => {
  it('names the page by its title', () => {
    expect(gatewayErrorMessage(502, '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>cloudflare</center></body></html>'))
      .toBe('Supabase answered HTTP 502 without JSON: 502 Bad Gateway')
  })

  it('names only the status for a body without a title: anything else in it may differ per request', () => {
    expect(gatewayErrorMessage(503, 'upstream connect error or disconnect/reset before headers. reset reason: connection failure'))
      .toBe('Supabase answered HTTP 503 without JSON')
    expect(gatewayErrorMessage(502, '<h1>Error 502</h1><p>Request ID: 7f3a9c21-4b6e-4d2a-9c1f-0e5d8a7b6c43</p>'))
      .toBe('Supabase answered HTTP 502 without JSON')
  })

  it('keeps at most 100 characters of a title, and reads it from the head of the page only', () => {
    expect(gatewayErrorMessage(500, `<title>${'x'.repeat(300)}</title>`)).toBe(`Supabase answered HTTP 500 without JSON: ${'x'.repeat(100)}`)
    expect(gatewayErrorMessage(500, `${' '.repeat(20_000)}<title>late</title>`)).toBe('Supabase answered HTTP 500 without JSON')
  })
})
