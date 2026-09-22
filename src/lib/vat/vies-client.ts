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
 * Validate a VAT number against the EU VIES REST API.
 *
 * 1. Parses the prefix and number
 * 2. Checks format locally
 * 3. Calls the VIES REST API with a 10s timeout
 * 4. Returns a VatValidationResult
 */
export async function validateVatNumber(rawVatNumber: string): Promise<VatValidationResult> {
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

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), VIES_TIMEOUT_MS)

    const response = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${viesPrefix}/vat/${vatNumber}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }
    )

    clearTimeout(timeout)

    if (!response.ok) {
      return {
        valid: false,
        error: 'VAT validation service unavailable. Please try again later.',
      }
    }

    const data = await response.json()
    const isValid = data.isValid === true

    return {
      valid: isValid,
      name: data.name || undefined,
      address: data.address || undefined,
      country_code: viesPrefix,
      vat_number: `${viesPrefix}${vatNumber}`,
    }
  } catch (error) {
    log.error('VIES API error:', error)
    return {
      valid: false,
      error: 'Could not verify VAT number. Service temporarily unavailable.',
    }
  }
}
