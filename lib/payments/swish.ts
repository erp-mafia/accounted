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

const SWISH_FORETAG = /^123\d{7}$/
const SWEDISH_MOBILE = /^07\d{8}$/

export function normaliseSwish(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/[\s-]/g, '')
}

export function isValidSwish(normalised: string): boolean {
  return normalised === '' || SWISH_FORETAG.test(normalised) || SWEDISH_MOBILE.test(normalised)
}
