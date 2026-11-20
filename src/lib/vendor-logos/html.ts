/**
 * The icons a home page declares, read from its <link> tags. Pure, and
 * deliberately small: the page is untrusted text, so this only scans for
 * tags and attributes with bounded regular expressions, never evaluates
 * anything, and resolves every href against the page URL (or its <base>).
 */

export type IconKind = 'apple-touch-icon' | 'svg-icon' | 'icon'

export interface IconLink {
  kind: IconKind
  /** Absolute URL (https:, or a data: URL as written). */
  url: string
  /** The largest size the page declares for it, in px; null when unstated (or "any"). */
  declaredSize: number | null
}

const TAG = /<(link|base)\b([^>]{0,2000})>/gi
const ATTR = /([a-z][a-z0-9:_-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase()
    if (out.has(name)) continue
    let value = m[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out.set(name, decodeEntities(value.trim()))
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

/** The largest WxH in a sizes attribute ("16x16 180x180"), or null for none or "any". */
export function largestDeclaredSize(sizes: string | undefined): number | null {
  if (!sizes) return null
  let best: number | null = null
  for (const m of sizes.toLowerCase().matchAll(/(\d{1,5})x(\d{1,5})/g)) {
    const size = Math.min(Number(m[1]), Number(m[2]))
    if (best === null || size > best) best = size
  }
  return best
}

function resolveHref(href: string, base: string): string | null {
  if (!href) return null
  if (/^data:/i.test(href)) return href
  try {
    const url = new URL(href, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function isSvg(type: string | undefined, url: string): boolean {
  if (type && /svg/i.test(type)) return true
  if (/^data:image\/svg\+xml/i.test(url)) return true
  try {
    return /\.svgz?$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/**
 * The icon links of a page, in document order. Reads up to </head> when
 * there is one (icons live there; a body full of user content does not get
 * a say). mask-icon (Safari's one-colour silhouette) is not an icon here.
 */
export function iconLinks(html: string, pageUrl: string): IconLink[] {
  const headEnd = html.search(/<\/head\s*>/i)
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html
  let base = pageUrl
  const out: IconLink[] = []
  for (const m of head.matchAll(TAG)) {
    const attrs = attributes(m[2]!)
    if (m[1]!.toLowerCase() === 'base') {
      const href = attrs.get('href')
      const resolved = href ? resolveHref(href, pageUrl) : null
      if (resolved && !resolved.startsWith('data:')) base = resolved
      continue
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (rel.length === 0) continue
    const url = resolveHref(attrs.get('href') ?? '', base)
    if (!url) continue
    const declaredSize = largestDeclaredSize(attrs.get('sizes'))
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
      out.push({ kind: 'apple-touch-icon', url, declaredSize })
    } else if (rel.includes('icon')) {
      out.push({ kind: isSvg(attrs.get('type'), url) ? 'svg-icon' : 'icon', url, declaredSize })
    }
  }
  return out
}
