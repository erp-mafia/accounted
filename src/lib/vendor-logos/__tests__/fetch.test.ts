import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { decodeDataUrl, fetchVendorIcon, iconCandidates, MAX_HTML_BYTES, readCapped, USER_AGENT, type FetchDeps } from '../fetch'

type Reply = { status?: number; body?: string | Buffer; headers?: Record<string, string> } | 'timeout' | 'network'

const tile = await sharp({ create: { width: 180, height: 180, channels: 4, background: '#1e40af' } }).png().toBuffer()
const small = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#1e40af' } }).png().toBuffer()

const html = (head: string) => ({ body: `<!doctype html><html><head>${head}</head><body></body></html>`, headers: { 'content-type': 'text/html; charset=utf-8' } })
const image = (bytes: Buffer, type = 'image/png') => ({ body: bytes, headers: { 'content-type': type } })

/** A fake web: URL -> reply. Unknown URLs are 404. Records every request. */
function web(routes: Record<string, Reply>, opts: { unsafeHosts?: string[]; noDns?: string[] } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url)
    calls.push({ url: key, init: init ?? {} })
    const reply = routes[key]
    if (reply === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    if (reply === 'network') throw new TypeError('fetch failed')
    if (!reply) return new Response('not found', { status: 404 })
    const body = typeof reply.body === 'string' || reply.body === undefined ? (reply.body ?? null) : new Uint8Array(reply.body)
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers })
  }) as unknown as typeof fetch
  const validateUrl = vi.fn(async (raw: string) => {
    const host = new URL(raw).hostname
    if (opts.noDns?.includes(host)) return { ok: false as const, reason: 'no_dns_records' as const, detail: '' }
    if (opts.unsafeHosts?.includes(host)) return { ok: false as const, reason: 'private_address' as const, detail: '' }
    return { ok: true as const, hostname: host, resolvedAddresses: ['93.184.216.34'] }
  }) as unknown as typeof validateWebhookUrl
  const deps: FetchDeps = { fetchImpl, validateUrl }
  return { deps, calls }
}

describe('fetchVendorIcon', () => {
  it('takes the largest apple-touch-icon, names itself and never follows redirects blindly', async () => {
    const { deps, calls } = web({
      'https://loopia.se/': html('<link rel="apple-touch-icon" sizes="120x120" href="/t120.png"><link rel="apple-touch-icon" sizes="180x180" href="/t180.png">'),
      'https://loopia.se/t180.png': image(tile),
    })
    const out = await fetchVendorIcon('loopia.se', deps)
    expect(out).toMatchObject({ status: 'found', source: 'apple-touch-icon' })
    expect(calls.map((c) => c.url)).toEqual(['https://loopia.se/robots.txt', 'https://loopia.se/', 'https://loopia.se/t180.png'])
    for (const c of calls) {
      expect(c.init.redirect).toBe('manual')
      expect((c.init.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT)
    }
  })

  it('falls through the order: SVG icon, then a large icon, then the root apple-touch-icon', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'
    const a = web({
      'https://a.se/': html('<link rel="apple-touch-icon" href="/gone.png"><link rel="icon" type="image/svg+xml" href="/i.svg">'),
      'https://a.se/i.svg': { body: svg, headers: { 'content-type': 'image/svg+xml' } },
    })
    expect(await fetchVendorIcon('a.se', a.deps)).toMatchObject({ status: 'found', source: 'svg-icon' })

    const b = web({
      'https://b.se/': html('<link rel="icon" sizes="32x32" href="/i32.png"><link rel="icon" sizes="192x192" href="/i192.png">'),
      'https://b.se/i192.png': image(tile),
    })
    expect(await fetchVendorIcon('b.se', b.deps)).toMatchObject({ status: 'found', source: 'icon' })
    expect(b.calls.some((c) => c.url.endsWith('/i32.png'))).toBe(false)

    const c = web({ 'https://c.se/': html(''), 'https://c.se/apple-touch-icon.png': image(tile) })
    expect(await fetchVendorIcon('c.se', c.deps)).toMatchObject({ status: 'found', source: 'root-apple-touch-icon' })
  })

  it('is missing when the only icons are too small or not images', async () => {
    const { deps } = web({
      'https://d.se/': html('<link rel="apple-touch-icon" href="/t.png"><link rel="icon" href="/x.png">'),
      'https://d.se/t.png': image(small),
      'https://d.se/x.png': { body: '<html>soft 404</html>', headers: { 'content-type': 'text/html' } },
    })
    expect(await fetchVendorIcon('d.se', deps)).toEqual({ status: 'missing', reason: 'no_usable_icon' })
  })

  it('refuses an icon over 300 KB without reading it', async () => {
    const { deps } = web({
      'https://e.se/': html('<link rel="apple-touch-icon" href="/big.png">'),
      'https://e.se/big.png': { body: tile, headers: { 'content-type': 'image/png', 'content-length': String(400 * 1024) } },
    })
    expect((await fetchVendorIcon('e.se', deps)).status).toBe('missing')
  })

  it('follows at most three redirects, checking every hop', async () => {
    const ok = web({
      'https://f.se/': { status: 301, headers: { location: 'https://www.f.se/' } },
      'https://www.f.se/': html('<link rel="apple-touch-icon" href="/t.png">'),
      'https://www.f.se/t.png': image(tile),
    })
    expect((await fetchVendorIcon('f.se', ok.deps)).status).toBe('found')

    const loop = web({
      'https://g.se/': { status: 302, headers: { location: 'https://g.se/1' } },
      'https://g.se/1': { status: 302, headers: { location: 'https://g.se/2' } },
      'https://g.se/2': { status: 302, headers: { location: 'https://g.se/3' } },
      'https://g.se/3': { status: 302, headers: { location: 'https://g.se/4' } },
      'https://g.se/apple-touch-icon.png': image(tile),
    })
    expect(await fetchVendorIcon('g.se', loop.deps)).toMatchObject({ status: 'found', source: 'root-apple-touch-icon' })
    expect(loop.calls.some((c) => c.url === 'https://g.se/4')).toBe(false)
  })

  it('blocks a redirect to a private address, and never connects to it', async () => {
    const { deps, calls } = web(
      { 'https://h.se/': { status: 302, headers: { location: 'https://internal.h.se/' } } },
      { unsafeHosts: ['internal.h.se'] },
    )
    expect(await fetchVendorIcon('h.se', deps)).toEqual({ status: 'blocked', reason: 'unsafe_address' })
    expect(calls.some((c) => c.url.startsWith('https://internal.h.se'))).toBe(false)
  })

  it('never leaves https or port 443', async () => {
    const http = web({ 'https://i.se/': { status: 301, headers: { location: 'http://i.se/' } } })
    expect((await fetchVendorIcon('i.se', http.deps)).status).toBe('missing')
    expect(http.calls.some((c) => c.url.startsWith('http://'))).toBe(false)

    const port = web({
      'https://j.se/': html('<link rel="apple-touch-icon" href="https://j.se:8443/t.png">'),
      'https://j.se:8443/t.png': image(tile),
    })
    expect((await fetchVendorIcon('j.se', port.deps)).status).toBe('missing')
    expect(port.calls.some((c) => c.url.includes(':8443'))).toBe(false)
  })

  it('honours robots.txt for our product token or *', async () => {
    const all = web({ 'https://k.se/robots.txt': { body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } } })
    expect(await fetchVendorIcon('k.se', all.deps)).toEqual({ status: 'blocked', reason: 'robots' })
    expect(all.calls.map((c) => c.url)).toEqual(['https://k.se/robots.txt'])

    const ours = web({
      'https://l.se/robots.txt': { body: 'User-agent: AccountedLogoFetcher\nDisallow: /icons/\n' },
      'https://l.se/': html('<link rel="apple-touch-icon" href="/icons/t.png">'),
      'https://l.se/apple-touch-icon.png': image(tile),
    })
    expect(await fetchVendorIcon('l.se', ours.deps)).toMatchObject({ status: 'found', source: 'root-apple-touch-icon' })
    expect(ours.calls.some((c) => c.url.endsWith('/icons/t.png'))).toBe(false)
  })

  it('retries later when robots.txt or the site is unreachable', async () => {
    const robots5xx = web({ 'https://m.se/robots.txt': { status: 503 } })
    expect(await fetchVendorIcon('m.se', robots5xx.deps)).toMatchObject({ status: 'retry' })

    const timeout = web({ 'https://n.se/': 'timeout' })
    expect(await fetchVendorIcon('n.se', timeout.deps)).toMatchObject({ status: 'retry', reason: 'timeout' })
  })

  it('gives up on a DNS lookup that never answers, and never connects', async () => {
    const hanging = web({ 'https://h.se/': html('') })
    const validateUrl = vi.fn(() => new Promise<never>(() => {})) as unknown as typeof validateWebhookUrl
    const out = await fetchVendorIcon('h.se', { ...hanging.deps, validateUrl, timeoutMs: 20 })
    expect(out).toMatchObject({ status: 'retry' })
    expect(hanging.calls).toEqual([])
  })

  it('never waits past the domain budget, whatever the per-request timeout', async () => {
    const { deps } = web({})
    // A host that answers after 5 s, unless the request is aborted first.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('', { status: 200 })), 5_000)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
          })
        }),
    ) as unknown as typeof fetch
    let clock = 0
    const pending = fetchVendorIcon('b2.se', { ...deps, fetchImpl, now: () => clock, timeoutMs: 8_000 })
    // The session started at 0; its first request goes out with 10 ms of the 45 s budget left.
    clock = 45_000 - 10
    const started = Date.now()
    expect(await pending).toMatchObject({ status: 'retry' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('is blocked on a 403, missing without DNS, excluded without a request', async () => {
    const forbidden = web({ 'https://o.se/': { status: 403 } })
    expect(await fetchVendorIcon('o.se', forbidden.deps)).toEqual({ status: 'blocked', reason: 'http_403' })

    const gone = web({}, { noDns: ['p.se'] })
    expect(await fetchVendorIcon('p.se', gone.deps)).toEqual({ status: 'missing', reason: 'no_dns' })

    const excluded = web({})
    expect(await fetchVendorIcon('skatteverket.se', excluded.deps)).toEqual({ status: 'excluded' })
    expect(await fetchVendorIcon('billogram.com', excluded.deps)).toEqual({ status: 'excluded' })
    expect(excluded.calls).toEqual([])
  })

  it('reads an inline data: icon without a request', async () => {
    const dataUrl = `data:image/png;base64,${tile.toString('base64')}`
    const { deps } = web({ 'https://q.se/': html(`<link rel="apple-touch-icon" href="${dataUrl}">`) })
    expect(await fetchVendorIcon('q.se', deps)).toMatchObject({ status: 'found', source: 'apple-touch-icon' })
  })
})

describe('helpers', () => {
  it('truncates a page at the cap and refuses an icon over it', async () => {
    const big = Buffer.alloc(MAX_HTML_BYTES + 10, 0x61)
    expect((await readCapped(new Response(big), MAX_HTML_BYTES, 'truncate'))?.byteLength).toBe(MAX_HTML_BYTES)
    expect(await readCapped(new Response(big), 1000, 'refuse')).toBeNull()
  })

  it('decodes only image data: URLs', () => {
    expect(decodeDataUrl('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E')?.toString()).toBe('<svg></svg>')
    expect(decodeDataUrl('data:text/html;base64,PGh0bWw+')).toBeNull()
  })

  it('orders candidates and adds the root icon once', () => {
    const out = iconCandidates(
      [
        { kind: 'icon', url: 'https://x.se/32.png', declaredSize: 32 },
        { kind: 'apple-touch-icon', url: 'https://x.se/apple-touch-icon.png', declaredSize: null },
      ],
      'https://x.se/',
    )
    expect(out).toEqual([{ url: 'https://x.se/apple-touch-icon.png', source: 'apple-touch-icon' }])
  })
})
