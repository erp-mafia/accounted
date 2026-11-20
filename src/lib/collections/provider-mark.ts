/**
 * The collections provider's mark: a square SVG that Connect serves beside
 * its catalogue entry, at `{connect base}/providers/{ref}.svg` (the ref is the
 * catalogue's opaque provider slug). The name, terms and fee wording already
 * reach the installation from the catalogue; the mark follows the same path,
 * so the installation never ships a provider's logo itself. A provider with no
 * file there shows the initials chip (BrandMark falls back when the image
 * fails to load). Pure.
 *
 * Only an https base yields a URL (the browser loads the image, and the
 * page's img-src allows https), plain http only for a loopback dev server, as
 * lib/connect/instance/config.ts allows for the connector itself.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function providerMarkUrl(baseUrl: string | null | undefined, ref: string | null | undefined): string | null {
  const slug = ref?.trim()
  if (!baseUrl || !slug) return null
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/providers/${encodeURIComponent(slug)}.svg`
}
