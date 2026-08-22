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

/** Local part of a sender address: conservative dot-atom subset, lowercase. */
export const SENDER_LOCAL_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function normalizeSenderLocalPart(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  return SENDER_LOCAL_PART_PATTERN.test(value) ? value : null
}
