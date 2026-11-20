/**
 * Hosts and registrable domains, for vendor logos. Pure.
 *
 * A vendor's logo is keyed by its registrable domain ("telia.se"), the host
 * a person would type, never a subdomain ("www.", "pending.uber.com",
 * "cloud.google.com" all key their parent): one icon per brand, fetched once.
 */

/**
 * Top-level domains a vendor host written in a bank text may end in. A host
 * in free text is only believed with one of these: "1.5" or "AB.SE"-shaped
 * noise must not become a domain, and an exotic TLD in a bank row is more
 * often a reference than a website.
 */
export const COMMON_TLDS: ReadonlySet<string> = new Set([
  'se', 'com', 'io', 'ai', 'app', 'net', 'nu', 'dev', 'co', 'org', 'eu', 'de', 'no', 'dk', 'fi', 'uk',
  'nl', 'fr', 'es', 'it', 'at', 'ch', 'be', 'ie', 'pl', 'ee', 'is', 'us', 'me', 'tv', 'info', 'shop',
  'store', 'tech', 'cloud', 'so', 'sh', 'gg', 'xyz', 'biz',
])

/**
 * Public suffixes of two labels under a country code: the registrable domain
 * under them has three labels ("bbc.co.uk"). Only the common ones; a
 * domain under an unlisted one keys its last two labels, which at worst
 * shares one icon between two sites of one suffix and is never a fetch of
 * a wrong host (the fetch goes to the domain as keyed).
 */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.za', 'com.tr', 'com.cn',
])

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * The registrable domain of a host, lower case, or null when it is not a
 * plausible public host (an IP address, a single label, a bad label, a
 * numeric TLD). With `commonTldsOnly`, a TLD outside COMMON_TLDS is null too.
 */
export function registrableDomain(host: string | null | undefined, opts: { commonTldsOnly?: boolean } = {}): string | null {
  if (!host) return null
  let h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253 || IPV4.test(h) || h.includes(':')) return null
  h = h.replace(/^www\d?\./, '')
  const labels = h.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  const tld = labels[labels.length - 1]!
  if (!/^[a-z]{2,24}$/.test(tld)) return null
  if (opts.commonTldsOnly && !COMMON_TLDS.has(tld)) return null
  const lastTwo = labels.slice(-2).join('.')
  const take = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2
  if (labels.length < take) return null
  return labels.slice(-take).join('.')
}

/** The label a brand is named by: "telia" for telia.se, "bbc" for bbc.co.uk. */
export function mainLabel(domain: string): string {
  const labels = domain.split('.')
  const lastTwo = labels.slice(-2).join('.')
  return labels[labels.length - (TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2)] ?? labels[0]!
}

const LEGAL_FORM_LABELS: ReadonlySet<string> = new Set(['ab', 'abp', 'hb', 'kb', 'inc', 'ltd', 'llc', 'gmbh', 'as', 'oy', 'aps', 'bv', 'nv', 'sa', 'plc'])

// A host in free text: dot-separated labels, not glued to a word or an
// address on the left ("faktura@telia.se" is a mail address, read by
// emailDomain), and not running on into more letters on the right.
const HOST_IN_TEXT = /(?<![a-z0-9@._-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/gi

/**
 * The registrable domains of the hosts written in a text, in order of
 * appearance, common TLDs only: "APPLE.COM/BILL" gives apple.com,
 * "WWW.CINODE.COM" cinode.com, "UBR* PENDING.UBER.COM" uber.com,
 * "SHIPMONDO.COM SE" shipmondo.com.
 */
export function hostsInText(text: string | null | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(HOST_IN_TEXT)) {
    const domain = registrableDomain(m[1], { commonTldsOnly: true })
    if (!domain || out.includes(domain)) continue
    // A main label of one letter, only digits ("3.se") or a legal form ("AB.SE") is noise in a bank text.
    const label = mainLabel(domain)
    if (label.length < 2 || /^\d+$/.test(label) || LEGAL_FORM_LABELS.has(label)) continue
    out.push(domain)
  }
  return out
}

/**
 * The registrable domain of a mail address, from a bare address or a
 * "Name <address>" header value, or null.
 */
export function emailDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(value)
  const address = bracketed?.[1] ?? /[^\s<>"',;]+@[^\s<>"',;]+/.exec(value)?.[0]
  if (!address) return null
  const host = address.slice(address.lastIndexOf('@') + 1)
  return registrableDomain(host)
}
