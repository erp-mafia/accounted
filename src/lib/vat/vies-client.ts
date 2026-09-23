import { createLogger } from '@/lib/logger'
import { EU_COUNTRIES } from '@/lib/vat/eu-countries'
import type { VatValidationResult } from '@/types'

const log = createLogger('vies-client')

const VIES_TIMEOUT_MS = 10_000

/**
 * VAT format patterns per VIES country prefix.
 * Greece uses 'EL' as its VIES prefix (not 'GR').
 */
const VAT_FORMAT_PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^0\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^[0-9A-Z]{8,9}$/,
  IT: /^\d{11}$/,
  LT: /^\d{9,12}$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
}

/** Valid VIES prefixes (derived from EU_COUNTRIES vatPrefix values) */
const VALID_VIES_PREFIXES = new Set(EU_COUNTRIES.map(c => c.vatPrefix))

/**
 * Parse a raw VAT number into its VIES prefix and numeric part.
 * Handles the GR → EL mapping automatically.
 *
 * @returns `{ viesPrefix, vatNumber }` or `null` if the prefix is not a valid EU country
 */
export function parseVatNumber(raw: string): { viesPrefix: string; vatNumber: string } | null {
  const cleaned = raw.replace(/\s/g, '').toUpperCase()

  if (cleaned.length < 3) return null

  const countryPrefix = cleaned.substring(0, 2)
  const vatNumber = cleaned.substring(2)

  // Map GR → EL for Greece (VIES uses EL, not GR)
  let viesPrefix = countryPrefix
  if (countryPrefix === 'GR') {
    viesPrefix = 'EL'
  }

  if (!VALID_VIES_PREFIXES.has(viesPrefix)) {
    return null
  }

  return { viesPrefix, vatNumber }
}

/**
 * Validate the format of a VAT number against country-specific patterns.
 */
export function validateVatFormat(viesPrefix: string, vatNumber: string): boolean {
  const pattern = VAT_FORMAT_PATTERNS[viesPrefix]
  if (!pattern) return false
  return pattern.test(vatNumber)
}

/**
 * VIES `userError` values that carry a definitive verdict. `VALID` and
 * `INVALID` mirror `isValid`; `INVALID_INPUT` means the number itself is
 * malformed for that member state. Every other code (MS_UNAVAILABLE,
 * MS_MAX_CONCURRENT_REQ, TIMEOUT, SERVICE_UNAVAILABLE, ...) means the member
 * state could not be asked, and VIES still answers HTTP 200 with
 * `isValid: false`. Reading that as "invalid" told users that correct
 * numbers were wrong, so anything outside this set is "unavailable".
 */
const DEFINITIVE_USER_ERRORS = new Set(['VALID', 'INVALID', 'INVALID_INPUT'])

/** Concurrency throttles clear quickly: worth exactly one retry. */
const RETRYABLE_USER_ERRORS = new Set([
  'MS_MAX_CONCURRENT_REQ',
  'MS_MAX_CONCURRENT_REQ_TIME',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ_TIME',
])

const VIES_RETRY_DELAY_MS = 1_500

const UNAVAILABLE_MESSAGE = 'VAT validation service unavailable. Please try again later.'

interface ViesResponse {
  isValid?: boolean
  userError?: string
  name?: string
  address?: string
}

async function fetchVies(viesPrefix: string, vatNumber: string): Promise<ViesResponse | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VIES_TIMEOUT_MS)
  try {
    const response = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${viesPrefix}/vat/${vatNumber}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }
    )
    if (!response.ok) return null
    return (await response.json()) as ViesResponse
  } finally {
    clearTimeout(timeout)
  }
}

function isDefinitive(data: ViesResponse): boolean {
  if (data.isValid === true) return true
  return data.userError === undefined || DEFINITIVE_USER_ERRORS.has(data.userError)
}

/**
 * Validate a VAT number against the EU VIES REST API.
 *
 * 1. Parses the prefix and number
 * 2. Checks format locally
 * 3. Calls the VIES REST API with a 10s timeout, retrying once after a short
 *    delay when VIES reports a concurrency throttle
 * 4. Returns a VatValidationResult. `unavailable: true` means VIES gave no
 *    verdict (member state down, throttled, timeout, network): `valid` is
 *    then false but must not be read or stored as "invalid".
 */
export async function validateVatNumber(
  rawVatNumber: string,
  options: { retryDelayMs?: number } = {}
): Promise<VatValidationResult> {
  const parsed = parseVatNumber(rawVatNumber)

  if (!parsed) {
    return { valid: false, error: 'Invalid or non-EU country prefix' }
  }

  const { viesPrefix, vatNumber } = parsed

  if (!validateVatFormat(viesPrefix, vatNumber)) {
    return {
      valid: false,
      country_code: viesPrefix,
      vat_number: `${viesPrefix}${vatNumber}`,
      error: 'Invalid VAT number format',
    }
  }

  const unavailable: VatValidationResult = {
    valid: false,
    unavailable: true,
    country_code: viesPrefix,
    vat_number: `${viesPrefix}${vatNumber}`,
    error: UNAVAILABLE_MESSAGE,
  }

  try {
    let data = await fetchVies(viesPrefix, vatNumber)
    if (data && !isDefinitive(data) && RETRYABLE_USER_ERRORS.has(data.userError ?? '')) {
      await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? VIES_RETRY_DELAY_MS))
      data = await fetchVies(viesPrefix, vatNumber)
    }

    if (!data) return unavailable

    if (!isDefinitive(data)) {
      log.warn('VIES gave no verdict', { country: viesPrefix, userError: data.userError })
      return unavailable
    }

    const isValid = data.isValid === true

    return {
      valid: isValid,
      name: data.name || undefined,
      address: data.address || undefined,
      country_code: viesPrefix,
      vat_number: `${viesPrefix}${vatNumber}`,
      ...(data.userError === 'INVALID_INPUT' ? { error: 'Invalid VAT number format' } : {}),
    }
  } catch (error) {
    log.error('VIES API error:', error)
    return { ...unavailable, error: 'Could not verify VAT number. Service temporarily unavailable.' }
  }
}

/**
 * The `vat_number_validated` columns to write after re-validating a
 * customer's VAT number on update, or `null` to leave them untouched.
 * A VIES outage must not wipe an earlier successful check of the same
 * number; a changed number is unverified until VIES answers.
 */
export function vatValidationColumns(
  result: VatValidationResult,
  previousVatNumber: string | null | undefined,
  nextVatNumber: string
): { vat_number_validated: boolean; vat_number_validated_at: string | null } | null {
  if (result.unavailable) {
    const normalize = (v: string) => v.replace(/\s/g, '').toUpperCase()
    if (previousVatNumber && normalize(previousVatNumber) === normalize(nextVatNumber)) return null
    return { vat_number_validated: false, vat_number_validated_at: null }
  }
  return {
    vat_number_validated: result.valid,
    vat_number_validated_at: result.valid ? new Date().toISOString() : null,
  }
}
