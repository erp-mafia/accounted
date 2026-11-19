/**
 * SIGNING_SEAL_*: the electronic seal on a signed copy
 * (lib/signing/pades-seal.ts). Unset = off: the signed copy is the stamped
 * PDF with its Signeringsbevis and no seal, checked at /verifiera only.
 *
 *   SIGNING_SEAL_P12_BASE64    the seal certificate with its private key and
 *                              chain: a PKCS#12 file (.p12/.pfx), base64
 *   SIGNING_SEAL_P12_PASSWORD  that file's password
 *   SIGNING_SEAL_TSA_URLS      RFC 3161 timestamp authorities, comma-separated,
 *                              tried in the order given
 *
 * All three, or no seal: a seal without a trusted time stops being
 * checkable the day its certificate expires, which is the one thing the
 * seal is for. A half-filled set says which variable is missing and seals
 * nothing, so a signed copy never waits on a typo.
 *
 * Hosted only in practice: there is no signing without a BankID provider.
 */
type Env = Record<string, string | undefined>

export type SigningSealConfig =
  | { state: 'off' }
  | { state: 'incomplete'; missing: string[] }
  | { state: 'on'; p12Base64: string; password: string; timestampUrls: string[] }

function httpUrls(raw: string | undefined): string[] {
  const urls: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !urls.includes(url.href)) urls.push(url.href)
    } catch {
      // Not a URL: left out, and the set counts as incomplete when none is.
    }
  }
  return urls
}

export function signingSealConfig(env: Env = process.env): SigningSealConfig {
  const p12Base64 = env.SIGNING_SEAL_P12_BASE64?.replace(/\s+/g, '') ?? ''
  // A password is taken as written: its own spaces may be part of it.
  const password = env.SIGNING_SEAL_P12_PASSWORD ?? ''
  const timestampUrls = httpUrls(env.SIGNING_SEAL_TSA_URLS)
  if (!p12Base64 && !password && !env.SIGNING_SEAL_TSA_URLS?.trim()) return { state: 'off' }
  const missing = [
    ...(p12Base64 ? [] : ['SIGNING_SEAL_P12_BASE64']),
    ...(password ? [] : ['SIGNING_SEAL_P12_PASSWORD']),
    ...(timestampUrls.length > 0 ? [] : ['SIGNING_SEAL_TSA_URLS']),
  ]
  if (missing.length > 0) return { state: 'incomplete', missing }
  return { state: 'on', p12Base64, password, timestampUrls }
}
