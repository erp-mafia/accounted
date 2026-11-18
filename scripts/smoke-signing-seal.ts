#!/usr/bin/env npx tsx
/**
 * First live seal with the configured seal certificate
 * (src/lib/signing/pades-seal.ts, SIGNING_SEAL_*).
 *
 * Unit tests seal with a throwaway certificate and no timestamp; they cannot
 * tell you whether the real certificate file opens, whether its chain and
 * revocation answers can be fetched, or whether the timestamp authorities
 * answer. This script seals one PDF exactly as a completed signing is
 * sealed and writes it out, so switching the seal on is one command and one
 * look in a validator instead of a customer's document.
 *
 * It reads only the three SIGNING_SEAL_* values, touches no database, and
 * sends nothing but hashes (to the timestamp authorities) and certificate
 * serial numbers (to the issuer's revocation service).
 *
 * Then check the file it wrote:
 *   - open it in Adobe Acrobat Reader: the signature panel should say the
 *     seal is valid, with a timestamp, and "LTV enabled";
 *   - or drop it on a PAdES validator and expect baseline B-LTA.
 *
 * Usage:
 *   npx tsx scripts/smoke-signing-seal.ts <out.pdf>            # seals a one-page sample
 *   npx tsx scripts/smoke-signing-seal.ts <out.pdf> <in.pdf>   # seals that PDF
 *   ENV_FILE=/path/to/seal.env npx tsx scripts/smoke-signing-seal.ts <out.pdf>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { config } from 'dotenv'

// With ENV_FILE the file is the only source of the seal settings: inherited
// values are cleared first, so a file missing one cannot borrow it from the shell.
if (process.env.ENV_FILE) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SIGNING_SEAL_')) delete process.env[key]
  }
  const loaded = config({ path: process.env.ENV_FILE, override: true })
  if (loaded.error) {
    console.error(`Cannot read ${process.env.ENV_FILE}: ${loaded.error.message}`)
    process.exit(1)
  }
}

import { signingSealConfig } from '@/lib/env/signing-seal'
import { createLogger } from '@/lib/logger'
import { loadSigningSeal } from '@/lib/signing/pades-seal'

async function samplePdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595.28, 841.89]).drawText('Provdokument: kontroll av forseglingen', { x: 56, y: 760, size: 14, font })
  await pdf.attach(new TextEncoder().encode('{"sample":true}'), 'signeringsbevis.json', { mimeType: 'application/json' })
  return pdf.save()
}

async function main(): Promise<void> {
  const [out, input] = process.argv.slice(2)
  if (!out) {
    console.error('Usage: npx tsx scripts/smoke-signing-seal.ts <out.pdf> [in.pdf]')
    process.exit(2)
  }
  const settings = signingSealConfig()
  if (settings.state === 'off') {
    console.error('No seal is configured: SIGNING_SEAL_P12_BASE64, SIGNING_SEAL_P12_PASSWORD and SIGNING_SEAL_TSA_URLS are all unset.')
    process.exit(1)
  }
  if (settings.state === 'incomplete') {
    console.error(`The seal is half configured. Missing: ${settings.missing.join(', ')}`)
    process.exit(1)
  }
  const seal = await loadSigningSeal(createLogger('smoke.signing-seal'))
  if (!seal) throw new Error('The seal did not load')
  console.log(`Certificate: ${seal.certificate.subject}`)
  console.log(`Issued by:   ${seal.certificate.issuer}`)
  console.log(`Valid:       ${seal.certificate.validFrom} to ${seal.certificate.validTo}`)
  console.log(`Timestamps:  ${settings.timestampUrls.join(', ')}`)

  const pdf = input ? new Uint8Array(readFileSync(input)) : await samplePdf()
  const started = Date.now()
  const sealed = await seal.apply(pdf)
  writeFileSync(out, sealed)
  console.log(`Sealed in ${Date.now() - started} ms: ${pdf.length} bytes in, ${sealed.length} bytes out.`)
  console.log(`Wrote ${out}. Open it in a PDF reader or a PAdES validator; a warning above means the file leans on its timestamp alone.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  process.exit(1)
})
