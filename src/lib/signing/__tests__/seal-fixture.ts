/**
 * A seal certificate for tests only: self-signed, "CN=Test seal, not a real
 * certificate", valid until 2126, made with openssl for this file. Its key
 * protects nothing; no reader trusts it. The tests seal with it and check
 * the seal's integrity themselves.
 */
import { createHash } from 'node:crypto'

export const TEST_SEAL_PASSWORD = 'test-seal'

export const TEST_SEAL_P12_BASE64 =
  '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'

const ascii = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')

/** The messageDigest attribute's OID followed by a SET holding one 32-byte OCTET STRING. */
const MESSAGE_DIGEST = Buffer.from('06092a864886f70d01090431220420', 'hex')

export interface SealIntegrity {
  /** The signature's byte ranges run from the first byte to the last, leaving out only the signature itself. */
  coversWholeFile: boolean
  /** The SHA-256 of those ranges is the digest the signature signs. */
  digestMatches: boolean
  subFilter: string | null
}

/**
 * What a PDF reader checks first on a signed file, for the first signature
 * in it: which bytes the signature covers, and that their hash is the one
 * inside the signature. (The signature over that hash is the library's and
 * the certificate's business; a full validator checks it at switch-on.)
 */
export function sealIntegrity(pdf: Uint8Array): SealIntegrity | null {
  const text = ascii(pdf)
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)
  if (!range) return null
  const [a, b, c, d] = range.slice(1).map(Number) as [number, number, number, number]
  const contents = /^<([0-9A-Fa-f]+)>$/.exec(text.slice(a + b, c))
  if (!contents) return null
  const cms = Buffer.from(contents[1]!, 'hex')
  const at = cms.indexOf(MESSAGE_DIGEST)
  const signedDigest = at < 0 ? null : cms.subarray(at + MESSAGE_DIGEST.length, at + MESSAGE_DIGEST.length + 32)
  const digest = createHash('sha256').update(pdf.subarray(a, a + b)).update(pdf.subarray(c, c + d)).digest()
  return {
    // Everything up to the first signature's own end: later updates (stored certificates, a second timestamp) follow it.
    coversWholeFile: a === 0 && c + d <= pdf.length && b > 0 && d > 0,
    digestMatches: signedDigest !== null && digest.equals(signedDigest),
    subFilter: /\/SubFilter\s*\/([A-Za-z0-9.]+)/.exec(text)?.[1] ?? null,
  }
}
