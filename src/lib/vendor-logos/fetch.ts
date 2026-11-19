/**
 * Fetch one vendor's icon from the vendor's own website. Server only.
 *
 * Called by the cron (./run.ts) once per domain, never per company and
 * never from a browser. Every request is guarded:
 *   - https only, port 443 only, no credentials in the URL, no IP literal;
 *   - every A/AAAA record of the host must be public: not private,
 *     loopback, link-local, CGNAT or cloud metadata (lib/webhooks/url-guard,
 *     the one definition of a safe address in the codebase, shared with
 *     lib/http/safe-fetch);
 *   - at most three redirects, each hop checked again like the first;
 *   - robots.txt honoured for our product token or `*` on every path we
 *     fetch (RFC 9309: a 4xx robots.txt allows all, an unreachable one
 *     allows nothing and the domain is retried later);
 *   - 8 s per DNS check and per request, never past the domain's 45 s
 *     budget, the home page read up to 500 KB (icons live in its head), an
 *     icon refused above 300 KB, and only an image content type.
 * The remaining DNS-rebinding window between the check and the connect is
 * the one lib/http/safe-fetch documents; acceptable for a read-only GET of
 * a public icon whose bytes we only ever hand to our own image pipeline.
 *
 * Icons are tried in this order: the largest apple-touch-icon of at least
 * 96 px, an SVG icon (rasterised), the largest PNG or ICO icon of at least
 * 96 px, then /apple-touch-icon.png at the site root. Whatever is found is
 * normalised to a 128 px PNG (./image.ts); nothing is stored here.
 */
import 'server-only'
import { isIP } from 'node:net'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { isExcludedDomain } from './excluded'
import { iconLinks, type IconLink } from './html'
import { normaliseIcon, MIN_SOURCE_SIZE, type NormalisedIcon } from './image'
import { ALLOW_ALL, parseRobots, robotsAllows, type RobotsRules } from './robots'

export const USER_AGENT = 'AccountedLogoFetcher/1.0 (+https://accounted.se)'
export const REQUEST_TIMEOUT_MS = 8_000
export const MAX_HTML_BYTES = 500 * 1024
export const MAX_ICON_BYTES = 300 * 1024
export const MAX_REDIRECTS = 3
/** A whole domain, every request together, never takes longer than this. */
export const DOMAIN_BUDGET_MS = 45_000

export type IconSource = 'apple-touch-icon' | 'svg-icon' | 'icon' | 'root-apple-touch-icon'

export type FetchOutcome =
  | { status: 'found'; icon: NormalisedIcon; source: IconSource }
  | { status: 'missing'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'excluded' }
  /** Something that may pass on a later try: a timeout, a 5xx, an unreachable robots.txt. */
  | { status: 'retry'; reason: string }

export interface FetchDeps {
  fetchImpl?: typeof fetch
  validateUrl?: typeof validateWebhookUrl
  timeoutMs?: number
  now?: () => number
}

type GetResult =
  | { kind: 'ok'; status: number; url: string; contentType: string; body: Buffer | null }
  | { kind: 'refused'; reason: 'unsafe_address' | 'not_https' | 'bad_port' | 'too_many_redirects' | 'robots' | 'bad_redirect' }
  | { kind: 'failed'; reason: 'timeout' | 'network' | 'dns' | 'no_dns' | 'robots_unreachable' | 'budget' }

interface GetOptions {
  accept: string
  maxBytes: number
  /** truncate: keep the first maxBytes (a page's head); refuse: a body over the cap is null (an icon). */
  overflow: 'truncate' | 'refuse'
  /** Check robots.txt before each hop (false for robots.txt itself). */
  robots: boolean
}

const REDIRECT = new Set([301, 302, 303, 307, 308])

async function cancel(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // The response is being dropped either way.
  }
}

/** The promise's value, or null when it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** The body up to `max` bytes: truncated, or null when over the cap and overflow is refuse. */
export async function readCapped(res: Response, max: number, overflow: 'truncate' | 'refuse'): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (overflow === 'refuse' && Number.isFinite(declared) && declared > max) {
    await cancel(res)
    return null
  }
  const body = res.body
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength <= max) return buf
    return overflow === 'truncate' ? buf.subarray(0, max) : null
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      if (overflow === 'refuse') return null
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - max))))
      return Buffer.concat(chunks)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** One domain's fetching: its robots.txt per origin, its time budget, its guarded GETs. */
class Session {
  private readonly fetchImpl: typeof fetch
  private readonly validateUrl: typeof validateWebhookUrl
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly deadline: number
  private readonly robots = new Map<string, Promise<RobotsRules | 'unreachable' | 'no_dns' | 'unsafe'>>()

  constructor(deps: FetchDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
    this.validateUrl = deps.validateUrl ?? validateWebhookUrl
    this.timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.now = deps.now ?? Date.now
    this.deadline = this.now() + DOMAIN_BUDGET_MS
  }

  private robotsFor(origin: string): Promise<RobotsRules | 'unreachable' | 'no_dns' | 'unsafe'> {
    let pending = this.robots.get(origin)
    if (!pending) {
      pending = (async () => {
        const res = await this.get(`${origin}/robots.txt`, { accept: 'text/plain,*/*;q=0.1', maxBytes: MAX_HTML_BYTES, overflow: 'truncate', robots: false })
        // A robots.txt behind a redirect we will not follow (to http, a loop) is unavailable: RFC 9309 allows all.
        if (res.kind === 'refused') return res.reason === 'unsafe_address' ? 'unsafe' : ALLOW_ALL
        if (res.kind === 'failed') return res.reason === 'no_dns' ? 'no_dns' : 'unreachable'
        if (res.status >= 200 && res.status < 300) return parseRobots((res.body ?? Buffer.alloc(0)).toString('utf8'))
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return ALLOW_ALL
        return 'unreachable'
      })()
      this.robots.set(origin, pending)
    }
    return pending
  }

  /** How long the next wait may last: one request's timeout, never past the domain's budget. */
  private waitMs(): number {
    return Math.min(this.timeoutMs, this.deadline - this.now())
  }

  async get(rawUrl: string, opts: GetOptions): Promise<GetResult> {
    let url = rawUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (this.now() > this.deadline) return { kind: 'failed', reason: 'budget' }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { kind: 'refused', reason: 'bad_redirect' }
      }
      if (parsed.protocol !== 'https:') return { kind: 'refused', reason: 'not_https' }
      if (parsed.port !== '' && parsed.port !== '443') return { kind: 'refused', reason: 'bad_port' }
      if (parsed.username || parsed.password) return { kind: 'refused', reason: 'unsafe_address' }
      const bare = parsed.hostname.replace(/^\[|\]$/g, '')
      if (isIP(bare) !== 0 || !bare.includes('.')) return { kind: 'refused', reason: 'unsafe_address' }

      if (opts.robots) {
        const rules = await this.robotsFor(parsed.origin)
        if (rules === 'unsafe') return { kind: 'refused', reason: 'unsafe_address' }
        if (rules === 'no_dns') return { kind: 'failed', reason: 'no_dns' }
        if (rules === 'unreachable') return { kind: 'failed', reason: 'robots_unreachable' }
        if (!robotsAllows(rules, `${parsed.pathname}${parsed.search}`)) return { kind: 'refused', reason: 'robots' }
      }

      // The DNS check and the request each wait at most what is left of the
      // domain's budget, so one slow host never outlives the cron's run.
      const dnsWait = this.waitMs()
      if (dnsWait <= 0) return { kind: 'failed', reason: 'budget' }
      const check = await within(this.validateUrl(parsed.toString()), dnsWait)
      if (check === null) return { kind: 'failed', reason: 'dns' }
      if (!check.ok) {
        if (check.reason === 'no_dns_records') return { kind: 'failed', reason: 'no_dns' }
        if (check.reason === 'dns_lookup_failed') return { kind: 'failed', reason: 'dns' }
        if (check.reason === 'invalid_url' || check.reason === 'non_https_scheme') return { kind: 'refused', reason: 'not_https' }
        return { kind: 'refused', reason: 'unsafe_address' }
      }

      const fetchWait = this.waitMs()
      if (fetchWait <= 0) return { kind: 'failed', reason: 'budget' }
      let res: Response
      try {
        res = await this.fetchImpl(parsed.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: { 'user-agent': USER_AGENT, accept: opts.accept },
          signal: AbortSignal.timeout(fetchWait),
        })
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        return { kind: 'failed', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
      }

      if (REDIRECT.has(res.status)) {
        const location = res.headers.get('location')
        await cancel(res)
        if (!location) return { kind: 'ok', status: res.status, url: parsed.toString(), contentType: '', body: null }
        try {
          url = new URL(location, parsed).toString()
        } catch {
          return { kind: 'refused', reason: 'bad_redirect' }
        }
        continue
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (res.status < 200 || res.status >= 300) {
        await cancel(res)
        return { kind: 'ok', status: res.status, url: parsed.toString(), contentType, body: null }
      }
      try {
        const body = await readCapped(res, opts.maxBytes, opts.overflow)
        return { kind: 'ok', status: res.status, url: parsed.toString(), contentType, body }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        return { kind: 'failed', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
      }
    }
    return { kind: 'refused', reason: 'too_many_redirects' }
  }
}

/** The bytes of a data: URL icon, when it is an image and within the icon cap. */
export function decodeDataUrl(url: string): Buffer | null {
  const m = /^data:([^,;]*)((?:;[^,;]*)*?),([\s\S]*)$/i.exec(url)
  if (!m) return null
  if (!/^image\//i.test(m[1]!.trim())) return null
  const base64 = /;base64/i.test(m[2]!)
  const payload = m[3]!
  if (payload.length > MAX_ICON_BYTES * 2) return null
  try {
    const bytes = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
    return bytes.byteLength <= MAX_ICON_BYTES ? bytes : null
  } catch {
    return null
  }
}

/** Declared size for ordering: an apple-touch-icon without sizes is almost always 180 px. */
function orderBySize(links: IconLink[], unknownAs: number): IconLink[] {
  return [...links].sort((a, b) => (b.declaredSize ?? unknownAs) - (a.declaredSize ?? unknownAs))
}

function bigEnough(link: IconLink): boolean {
  return link.declaredSize === null || link.declaredSize >= MIN_SOURCE_SIZE
}

/** The icon candidates in the order they are tried. */
export function iconCandidates(links: IconLink[], root: string): Array<{ url: string; source: IconSource }> {
  const apple = orderBySize(links.filter((l) => l.kind === 'apple-touch-icon' && bigEnough(l)), 180).slice(0, 2)
  const svg = links.filter((l) => l.kind === 'svg-icon').slice(0, 1)
  const icons = orderBySize(links.filter((l) => l.kind === 'icon' && bigEnough(l)), 0).slice(0, 2)
  const out: Array<{ url: string; source: IconSource }> = [
    ...apple.map((l) => ({ url: l.url, source: 'apple-touch-icon' as const })),
    ...svg.map((l) => ({ url: l.url, source: 'svg-icon' as const })),
    ...icons.map((l) => ({ url: l.url, source: 'icon' as const })),
    { url: new URL('/apple-touch-icon.png', root).toString(), source: 'root-apple-touch-icon' },
  ]
  const seen = new Set<string>()
  return out.filter((c) => {
    if (seen.has(c.url)) return false
    seen.add(c.url)
    return true
  })
}

/** Fetch, check and normalise one domain's icon. Never throws for anything the network does. */
export async function fetchVendorIcon(domain: string, deps: FetchDeps = {}): Promise<FetchOutcome> {
  if (isExcludedDomain(domain)) return { status: 'excluded' }
  const session = new Session(deps)
  let transient: string | null = null
  let blocked: string | null = null

  const home = await session.get(`https://${domain}/`, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    maxBytes: MAX_HTML_BYTES,
    overflow: 'truncate',
    robots: true,
  })
  let links: IconLink[] = []
  let root = `https://${domain}/`
  if (home.kind === 'refused') {
    // An unsafe address is a refusal of the domain; a redirect to http or a loop only means no page to read.
    if (home.reason === 'unsafe_address') return { status: 'blocked', reason: home.reason }
    if (home.reason === 'robots') blocked = 'robots'
  } else if (home.kind === 'failed') {
    if (home.reason === 'no_dns') return { status: 'missing', reason: 'no_dns' }
    transient = home.reason
  } else if (home.status === 401 || home.status === 403 || home.status === 451) {
    return { status: 'blocked', reason: `http_${home.status}` }
  } else if (home.status === 429 || home.status >= 500) {
    transient = `http_${home.status}`
  } else {
    root = new URL('/', home.url).toString()
    if (home.body && /html|xml/.test(home.contentType || 'text/html')) links = iconLinks(home.body.toString('utf8'), home.url)
  }

  for (const candidate of iconCandidates(links, root)) {
    let bytes: Buffer | null
    if (candidate.url.startsWith('data:')) {
      bytes = decodeDataUrl(candidate.url)
    } else {
      const res = await session.get(candidate.url, { accept: 'image/*', maxBytes: MAX_ICON_BYTES, overflow: 'refuse', robots: true })
      if (res.kind === 'refused') {
        if (res.reason === 'robots') blocked ??= 'robots'
        continue
      }
      if (res.kind === 'failed') {
        transient ??= res.reason
        continue
      }
      if (res.status === 429 || res.status >= 500) transient ??= `http_${res.status}`
      if (res.status < 200 || res.status >= 300 || !res.body) continue
      if (!res.contentType.startsWith('image/')) continue
      bytes = res.body
    }
    if (!bytes) continue
    const icon = await normaliseIcon(bytes)
    if (typeof icon !== 'string') return { status: 'found', icon, source: candidate.source }
  }

  if (blocked) return { status: 'blocked', reason: blocked }
  if (transient) return { status: 'retry', reason: transient }
  return { status: 'missing', reason: links.length > 0 ? 'no_usable_icon' : 'no_icon_links' }
}
