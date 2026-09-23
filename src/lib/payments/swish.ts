/**
 * Swish number normalisation + validation.
 *
 * Two accepted shapes:
 *   - Swish Företag: `123XXXXXXX` (10 digits starting with `123`)
 *   - Swedish mobile: `07XXXXXXXX` (10 digits starting with `07`)
 *
 * Whitespace and hyphens are stripped before validation so users can paste
 * formatted numbers (`123 456 78 90` or `070-123 45 67`) and have them
 * canonicalised.
 */

import { roundOre } from '@/lib/money'

const SWISH_FORETAG = /^123\d{7}$/
const SWEDISH_MOBILE = /^07\d{8}$/

export function normaliseSwish(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/[\s-]/g, '')
}

export function isValidSwish(normalised: string): boolean {
  return normalised === '' || SWISH_FORETAG.test(normalised) || SWEDISH_MOBILE.test(normalised)
}

/**
 * Build the Swish "Type C" QR payload: `C<payee>;<amount>;<message>;<editmask>`.
 *
 * editmask 0 locks payee, amount and message, so the Swish app opens prefilled
 * and uneditable. This is the documented format the Swish app scans directly,
 * so the QR can be generated entirely offline (no call to Swish's QR API).
 * Works for both Swish-företag (123XXXXXXX) and mobile (07XXXXXXXX) payees.
 *
 * Returns null when the number is missing/invalid or the amount is not positive.
 * Spec: Swish QR Code Design Specification (Getswish AB).
 */
export function buildSwishQrPayload(
  swishNumber: string | null | undefined,
  amount: number,
  message: string,
): string | null {
  const number = normaliseSwish(swishNumber)
  if (!number || !isValidSwish(number)) return null
  if (!(amount > 0)) return null
  // Amount uses a dot decimal with at most two decimals. The message must not
  // contain the ';' field delimiter; cap its length to keep the QR scannable.
  const amt = roundOre(amount).toFixed(2)
  const msg = (message ?? '').replace(/;/g, ' ').trim().slice(0, 50)
  return `C${number};${amt};${msg};0`
}
