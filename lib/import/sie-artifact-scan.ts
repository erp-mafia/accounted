/**
 * CP1252-artifact tripwire for SIE imports.
 *
 * Every in-repo SIE byte path decodes correctly (detectEncoding/decodeBuffer in
 * sie-parser.ts), but some import surfaces receive an ALREADY-DECODED string
 * (the provider-migration /import-sie handler takes rawContent as JSON). If an
 * upstream system decoded CP437 bytes as windows-1252 before handing us the
 * string, the damage is already baked in: CP437 diacritics become C1 specials
 * (o-umlaut 0x94 -> U+201D, a-umlaut 0x84 -> U+201E, A-umlaut 0x8E -> U+017D),
 * producing text like "Ink[U+201D]p tj[U+201E]nster" and "BANKTJ[U+017D]NSTER".
 * That exact corruption shipped through the retired Arcim Sync gateway on
 * 2026-03-17 and sat undetected in posted entries.
 *
 * This scanner is the tripwire: it flags parsed SIE text carrying that
 * signature so the import can WARN (never block) and the user can abort or
 * review. Detection reuses hasCp1252Artifact (lib/bookkeeping/charset-repair),
 * whose letter-adjacency heuristic ignores legitimate typography such as a
 * space-padded en dash. A minimum of two flagged fields is required before the
 * file as a whole is flagged, so a single legitimate curly quote in one
 * description cannot trigger the warning.
 */

import { hasCp1252Artifact } from '@/lib/bookkeeping/charset-repair'
import type { SIEAccount, SIEVoucher } from './types'

/** Minimum number of artifact-carrying text fields before the file is flagged. */
export const SIE_ARTIFACT_THRESHOLD = 2

/** Cap on distinct example strings carried in the result (for logs/messages). */
const MAX_SAMPLES = 3

export interface SieArtifactScanResult {
  /** True when artifactCount >= SIE_ARTIFACT_THRESHOLD. */
  flagged: boolean
  /** Number of text fields (account names, voucher/line descriptions) with artifacts. */
  artifactCount: number
  /** Up to MAX_SAMPLES distinct flagged strings, in encounter order. */
  samples: string[]
}

/**
 * Scan parsed SIE content (account names, voucher descriptions, transaction
 * line descriptions) for the CP437-decoded-as-CP1252 mojibake signature.
 * Pure function: no I/O, no side effects.
 */
export function scanSieForCp1252Artifacts(parsed: {
  accounts: SIEAccount[]
  vouchers: SIEVoucher[]
}): SieArtifactScanResult {
  let artifactCount = 0
  const samples: string[] = []

  const check = (text: string | undefined): void => {
    if (!text || !hasCp1252Artifact(text)) return
    artifactCount++
    if (samples.length < MAX_SAMPLES && !samples.includes(text)) {
      samples.push(text)
    }
  }

  for (const account of parsed.accounts) {
    check(account.name)
  }
  for (const voucher of parsed.vouchers) {
    check(voucher.description)
    for (const line of voucher.lines) {
      check(line.description)
    }
  }

  return {
    flagged: artifactCount >= SIE_ARTIFACT_THRESHOLD,
    artifactCount,
    samples,
  }
}

/**
 * User-facing Swedish warning for a flagged scan. SIE import warnings are a
 * Swedish-only surface (SIE is Swedish by spec); this follows the existing
 * warnings-array convention in sie-parser/sie-import rather than i18n keys.
 * The C1 special characters in the message are the mojibake signature itself,
 * quoted literally so the user can recognize them in their data.
 */
export function formatSieArtifactWarning(scan: SieArtifactScanResult): string {
  const example = scan.samples[0] ? ` (till exempel "${scan.samples[0]}")` : ''
  return (
    `Filens text verkar vara felaktigt teckenkodad: ${scan.artifactCount} textfält innehåller ` +
    `tecken som ”, „ eller Ž i stället för å, ä eller ö${example}. ` +
    `Importen blockeras inte, men granska kontonamn och verifikationstexter.`
  )
}
