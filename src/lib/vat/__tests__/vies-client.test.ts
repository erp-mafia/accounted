import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseVatNumber, validateVatFormat, validateVatNumber } from '../vies-client'

// Mock logger to suppress output
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('parseVatNumber', () => {
  it('parses a DE VAT number', () => {
    const result = parseVatNumber('DE123456789')
    expect(result).toEqual({ viesPrefix: 'DE', vatNumber: '123456789' })
  })

  it('parses a SE VAT number', () => {
    const result = parseVatNumber('SE123456789012')
    expect(result).toEqual({ viesPrefix: 'SE', vatNumber: '123456789012' })
  })

  it('maps GR to EL for Greece', () => {
    const result = parseVatNumber('GR123456789')
    expect(result).toEqual({ viesPrefix: 'EL', vatNumber: '123456789' })
  })

  it('accepts EL prefix directly', () => {
    const result = parseVatNumber('EL123456789')
    expect(result).toEqual({ viesPrefix: 'EL', vatNumber: '123456789' })
  })

  it('strips whitespace', () => {
    const result = parseVatNumber('DE 123 456 789')
    expect(result).toEqual({ viesPrefix: 'DE', vatNumber: '123456789' })
  })

  it('converts to uppercase', () => {
    const result = parseVatNumber('de123456789')
    expect(result).toEqual({ viesPrefix: 'DE', vatNumber: '123456789' })
  })

  it('rejects non-EU country prefix', () => {
    expect(parseVatNumber('US123456789')).toBeNull()
  })

  it('rejects too-short input', () => {
    expect(parseVatNumber('DE')).toBeNull()
  })

  it('parses FR VAT number with letters', () => {
    const result = parseVatNumber('FRXX999999999')
    expect(result).toEqual({ viesPrefix: 'FR', vatNumber: 'XX999999999' })
  })
})

describe('validateVatFormat', () => {
  it('validates DE format (9 digits)', () => {
    expect(validateVatFormat('DE', '123456789')).toBe(true)
    expect(validateVatFormat('DE', '12345678')).toBe(false)
    expect(validateVatFormat('DE', '1234567890')).toBe(false)
  })

  it('validates SE format (12 digits)', () => {
    expect(validateVatFormat('SE', '123456789012')).toBe(true)
    expect(validateVatFormat('SE', '12345678901')).toBe(false)
  })

  it('validates EL (Greece) format (9 digits)', () => {
    expect(validateVatFormat('EL', '123456789')).toBe(true)
    expect(validateVatFormat('EL', '12345678')).toBe(false)
  })

  it('validates AT format (U + 8 digits)', () => {
    expect(validateVatFormat('AT', 'U12345678')).toBe(true)
    expect(validateVatFormat('AT', '12345678')).toBe(false)
  })

  it('validates NL format (9 digits + B + 2 digits)', () => {
    expect(validateVatFormat('NL', '123456789B12')).toBe(true)
    expect(validateVatFormat('NL', '123456789A12')).toBe(false)
  })

  it('validates FR format (2 alphanums + 9 digits)', () => {
    expect(validateVatFormat('FR', 'XX999999999')).toBe(true)
    expect(validateVatFormat('FR', '9999999999')).toBe(false) // only 10 chars
  })

  it('returns false for unknown prefix', () => {
    expect(validateVatFormat('XX', '123456789')).toBe(false)
  })
})

describe('validateVatNumber', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns error for non-EU prefix', async () => {
    const result = await validateVatNumber('US123456789')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-EU')
  })

  it('returns error for invalid format without calling VIES', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await validateVatNumber('DE12345') // too short for DE
    expect(result.valid).toBe(false)
    expect(result.error).toContain('format')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns valid result from VIES API', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        isValid: true,
        name: 'Test Company GmbH',
        address: 'Berlin, Germany',
      }), { status: 200 })
    )

    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(true)
    expect(result.name).toBe('Test Company GmbH')
    expect(result.address).toBe('Berlin, Germany')
    expect(result.country_code).toBe('DE')
    expect(result.vat_number).toBe('DE123456789')
  })

  it('returns invalid result from VIES API', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: false }), { status: 200 })
    )

    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(false)
    expect(result.country_code).toBe('DE')
  })

  it('handles VIES service unavailable (non-200)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 })
    )

    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('unavailable')
  })

  it('handles network error gracefully', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('unavailable')
  })

  it('handles GR→EL mapping in API call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: true }), { status: 200 })
    )

    await validateVatNumber('GR123456789')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/ms/EL/vat/'),
      expect.any(Object)
    )
  })
})
