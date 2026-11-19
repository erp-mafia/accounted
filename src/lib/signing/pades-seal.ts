/**
 * The electronic seal on a signed copy: a PAdES signature (ETSI EN 319 142-1,
 * baseline B-LTA) made with the platform's seal certificate over the whole
 * file, so the copy proves itself in any PDF reader, to anyone, without
 * asking us (./verify.ts needs our database; the seal does not).
 *
 *   - The signature covers every byte: the stamped pages, the
 *     Signeringsbevis and the files ./seal.ts attaches (the original that
 *     was signed and a manifest with each BankID signature's fingerprint).
 *   - A timestamp from an RFC 3161 authority fixes when it was sealed.
 *   - The certificates and their revocation answers are stored in the file
 *     and a second timestamp covers them, so the seal can still be checked
 *     after its certificate has expired.
 *
 * The seal is appended as incremental updates: nothing of the copy is
 * rewritten, and a seal that would is refused.
 *
 * The seal says "this is the copy Accounted made when everyone had signed,
 * unchanged since". It is not anyone's signature: those are the BankID
 * signatures, which stay in the evidence package (they carry each signer's
 * full personnummer).
 *
 * Off until SIGNING_SEAL_* is set (lib/env/signing-seal.ts). The certificate
 * comes as a PKCS#12 file today; a certificate whose key lives with its
 * issuer (a remote seal) is another Signer behind the same loadSigningSeal.
 */
import { X509Certificate } from 'node:crypto'
import type { Signer, TimestampAuthority } from '@libpdf/core'
import { signingSealConfig } from '@/lib/env/signing-seal'
import type { Logger } from '@/lib/logger'

/** The signature field's name in the file. */
const SEAL_FIELD = 'Forsegling'
/** What a PDF reader shows as the reason for the signature. */
const SEAL_REASON = 'Försegling efter signering med BankID'
/**
 * Room reserved for the signature: the certificate with its chain and the
 * timestamp token with the authority's chain. The library's 12 KB holds a
 * short test chain, not an issued certificate's.
 */
const SEAL_SIGNATURE_BYTES = 32 * 1024
const TIMESTAMP_TIMEOUT_MS = 15_000
/** From this long before the certificate runs out, every seal says so in the log. */
const EXPIRY_NOTICE_MS = 30 * 24 * 60 * 60 * 1000

export interface SigningSeal {
  /** Whose seal it is and how long the certificate lasts. */
  certificate: { subject: string; issuer: string; validFrom: string; validTo: string }
  /** The same file with the seal appended. */
  apply(pdf: Uint8Array): Promise<Uint8Array>
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** One authority out of several: each is asked in turn until one answers. */
export function firstTimestampThatAnswers(authorities: Array<{ url: string; authority: TimestampAuthority }>, log: Logger): TimestampAuthority {
  return {
    async timestamp(digest, algorithm) {
      let last: unknown = new Error('No timestamp authority is configured')
      for (const { url, authority } of authorities) {
        try {
          return await authority.timestamp(digest, algorithm)
        } catch (err) {
          last = err
          log.warn('timestamp authority did not answer', { url, error: message(err) })
        }
      }
      throw last
    },
  }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length > prefix.length && Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length).equals(Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length))
}

/**
 * Seal a PDF. With a timestamp authority the seal is long-lived (B-LTA);
 * without one it is the bare signature (B-B), which only the tests ask for.
 */
export async function sealPdf(pdf: Uint8Array, input: { signer: Signer; timestampAuthority: TimestampAuthority | null; log: Logger }): Promise<Uint8Array> {
  const { PDF } = await import('@libpdf/core')
  const document = await PDF.load(pdf)
  const { bytes, warnings } = await document.sign({
    signer: input.signer,
    fieldName: SEAL_FIELD,
    reason: SEAL_REASON,
    estimatedSize: SEAL_SIGNATURE_BYTES,
    ...(input.timestampAuthority ? { level: 'B-LTA' as const, timestampAuthority: input.timestampAuthority } : { level: 'B-B' as const }),
  })
  // A certificate whose revocation answer could not be fetched still seals; the file then leans on its timestamp alone.
  for (const warning of warnings) input.log.warn('signing seal made with a warning', { code: warning.code, warning: warning.message })
  if (!startsWith(bytes, pdf)) throw new Error('The seal rewrote the signed copy instead of appending to it')
  return bytes
}

/**
 * The seal the environment configures, or null when there is none (unset, or
 * half set and said so). A certificate outside its validity is refused: the
 * library would sign with it all the same, and every reader would then
 * reject the seal.
 */
export async function loadSigningSeal(log: Logger, env: Record<string, string | undefined> = process.env, now: number = Date.now()): Promise<SigningSeal | null> {
  const config = signingSealConfig(env)
  if (config.state === 'off') return null
  if (config.state === 'incomplete') {
    log.warn('signing seal is half configured, signed copies get no seal', { missing: config.missing })
    return null
  }
  const { HttpTimestampAuthority, P12Signer } = await import('@libpdf/core')
  // buildChain: an issuer certificate the file leaves out is fetched, so the seal carries its whole chain.
  const signer = await P12Signer.create(new Uint8Array(Buffer.from(config.p12Base64, 'base64')), config.password, { buildChain: true })
  const x509 = new X509Certificate(Buffer.from(signer.certificate))
  const certificate = {
    subject: x509.subject.replace(/\n/g, ', '),
    issuer: x509.issuer.replace(/\n/g, ', '),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
  }
  const expires = Date.parse(certificate.validTo)
  if (now < Date.parse(certificate.validFrom) || now >= expires) {
    throw new Error(`The signing seal certificate is not valid now (valid ${certificate.validFrom} to ${certificate.validTo})`)
  }
  if (expires - now < EXPIRY_NOTICE_MS) log.warn('signing seal certificate runs out soon', { validTo: certificate.validTo })
  const timestampAuthority = firstTimestampThatAnswers(
    config.timestampUrls.map((url) => ({ url, authority: new HttpTimestampAuthority(url, { timeout: TIMESTAMP_TIMEOUT_MS }) })),
    log,
  )
  return { certificate, apply: (pdf) => sealPdf(pdf, { signer, timestampAuthority, log }) }
}
