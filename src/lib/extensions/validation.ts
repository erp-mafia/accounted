import { luhnValidate } from '@/lib/bankgiro/luhn'

/**
 * Validates a Swedish personal number (YYYYMMDD-XXXX) using Luhn checksum.
 * Returns an error message string, or null if valid.
 */
export function validateSwedishPersonalNumber(pnr: string): string | null {
  if (!pnr) return 'Personnummer kravs'

  // Accept YYYYMMDD-XXXX or YYYYMMDDXXXX
  const cleaned = pnr.replace(/[-\s]/g, '')
  if (!/^\d{12}$/.test(cleaned)) {
    return 'Format: YYYYMMDD-XXXX (12 siffror)'
  }

  const year = parseInt(cleaned.slice(0, 4))
  const month = parseInt(cleaned.slice(4, 6))
  const day = parseInt(cleaned.slice(6, 8))

  if (month < 1 || month > 12) return 'Ogiltig månad'
  if (day < 1 || day > 31) return 'Ogiltig dag'
  if (year < 1900 || year > new Date().getFullYear()) return 'Ogiltigt år'

  // Luhn check on the last 10 digits (YYMMDDXXXX)
  const luhnDigits = cleaned.slice(2)
  if (!luhnValidate(luhnDigits)) return 'Ogiltig kontrollsiffra'

  return null
}

export function validatePositiveNumber(value: number | string): string | null {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num) || num <= 0) return 'Varde maste vara storre an 0'
  return null
}

export function validateNonNegativeNumber(value: number | string): string | null {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num) || num < 0) return 'Varde kan inte vara negativt'
  return null
}

export function validateMaxNumber(value: number | string, max: number): string | null {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return 'Ogiltigt varde'
  if (num > max) return `Varde kan inte overskrida ${max}`
  return null
}

export function validateRequired(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return 'Obligatoriskt falt'
  return null
}

export function validateDateNotFuture(dateStr: string): string | null {
  if (!dateStr) return 'Datum kravs'
  const date = new Date(dateStr)
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  if (date > today) return 'Datum kan inte vara i framtiden'
  return null
}
