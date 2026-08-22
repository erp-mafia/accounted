import { domainToASCII } from 'node:url'

/**
 * Hostname normalization for user-entered email domains.
 *
 * Accepts what users actually paste ("Faktura.Hansbolag.SE.", a full URL, or
 * an email address) and reduces it to a lowercased, punycoded hostname.
 * Returns null when no valid hostname can be extracted. Dependency-free so
 * both core and extensions can share one definition of "a valid domain".
 */
export function normalizeDomainName(raw: string): string | null {
  let value = String(raw ?? '').trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme
  value = value.split('/')[0].split('?')[0]
  const atIndex = value.lastIndexOf('@')
  if (atIndex !== -1) value = value.slice(atIndex + 1)
  value = value.replace(/^\.+|\.+$/g, '')
  if (!value) return null

  // IDN -> punycode (blåbär.se -> xn--blbr-noab.se). Returns '' when the
  // input is not a valid domain.
  const ascii = domainToASCII(value)
  if (!ascii) return null

  return isValidHostname(ascii) ? ascii : null
}

export function isValidHostname(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false
  // TLD must contain a letter: rejects IP addresses and all-numeric TLDs.
  return /[a-z]/.test(labels[labels.length - 1])
}

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Domains no tenant may ever send as: the platform's own sender domain
 * (RESEND_FROM_EMAIL), the shared inbound domain, and the app host, plus
 * their subdomains. Read from env on every call (cheap, and tests flip env).
 */
export function reservedSenderDomains(): string[] {
  const reserved: string[] = []
  const fromDomain = process.env.RESEND_FROM_EMAIL
    ? normalizeDomainName(process.env.RESEND_FROM_EMAIL)
    : null
  if (fromDomain) reserved.push(fromDomain)
  const inbound = process.env.RESEND_INBOUND_DOMAIN?.toLowerCase()
  if (inbound) reserved.push(inbound)
  const appHost = hostnameOf(process.env.NEXT_PUBLIC_APP_URL)
  if (appHost) reserved.push(appHost)
  return reserved
}

/** True when `domain` is a reserved platform domain or a subdomain of one. */
export function isReservedSenderDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  return reservedSenderDomains().some((r) => d === r || d.endsWith(`.${r}`))
}

/**
 * Local part of a sender address: conservative dot-atom subset, lowercase.
 * Dots may only separate atoms (RFC 5322 dot-atom): no leading, trailing or
 * consecutive dots. Mirrored by the CHECK constraint in
 * 20260822130000_company_sending_domains_tenant_guard.sql.
 */
export const SENDER_LOCAL_PART_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/
const SENDER_LOCAL_PART_MAX_LENGTH = 64

export function normalizeSenderLocalPart(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value.length === 0 || value.length > SENDER_LOCAL_PART_MAX_LENGTH) return null
  return SENDER_LOCAL_PART_PATTERN.test(value) ? value : null
}
