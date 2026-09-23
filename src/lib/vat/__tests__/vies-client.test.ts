import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseVatNumber, validateVatFormat, validateVatNumber, vatValidationColumns } from '../vies-client'

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

describe('validateVatNumber: VIES userError semantics', () => {
  const vies = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 200 })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('treats userError INVALID as a definitive invalid verdict', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(vies({ isValid: false, userError: 'INVALID' }))
    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(false)
    expect(result.unavailable).toBeUndefined()
  })

  it('treats userError VALID as valid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(vies({ isValid: true, userError: 'VALID', name: 'SA X' }))
    const result = await validateVatNumber('FR40303265045')
    expect(result).toMatchObject({ valid: true, name: 'SA X', vat_number: 'FR40303265045' })
    expect(result.unavailable).toBeUndefined()
  })

  it('treats INVALID_INPUT as a definitive input error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(vies({ isValid: false, userError: 'INVALID_INPUT' }))
    const result = await validateVatNumber('DE123456789')
    expect(result.valid).toBe(false)
    expect(result.unavailable).toBeUndefined()
    expect(result.error).toContain('format')
  })

  it.each(['MS_UNAVAILABLE', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'VAT_BLOCKED', 'IP_BLOCKED'])(
    'reports %s as unavailable, not invalid, without retrying',
    async (userError) => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(vies({ isValid: false, userError }))
      const result = await validateVatNumber('FR40303265045', { retryDelayMs: 0 })
      expect(result).toMatchObject({ valid: false, unavailable: true, country_code: 'FR' })
      expect(result.error).toContain('unavailable')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    }
  )

  it('retries once on MS_MAX_CONCURRENT_REQ and uses the second answer', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(vies({ isValid: false, userError: 'MS_MAX_CONCURRENT_REQ' }))
      .mockResolvedValueOnce(vies({ isValid: true, userError: 'VALID', name: 'SA X' }))
    const result = await validateVatNumber('FR40303265045', { retryDelayMs: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.valid).toBe(true)
    expect(result.unavailable).toBeUndefined()
  })

  it('stays unavailable when the retry is throttled too', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(vies({ isValid: false, userError: 'GLOBAL_MAX_CONCURRENT_REQ' }))
      .mockResolvedValueOnce(vies({ isValid: false, userError: 'MS_MAX_CONCURRENT_REQ' }))
    const result = await validateVatNumber('FR40303265045', { retryDelayMs: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ valid: false, unavailable: true })
  })

  it('marks HTTP errors and network failures as unavailable', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('down', { status: 503 }))
    expect((await validateVatNumber('DE123456789')).unavailable).toBe(true)
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))
    expect((await validateVatNumber('DE123456789')).unavailable).toBe(true)
  })
})

describe('vatValidationColumns', () => {
  it('stamps a valid verdict', () => {
    const cols = vatValidationColumns({ valid: true }, null, 'DE123456789')
    expect(cols?.vat_number_validated).toBe(true)
    expect(cols?.vat_number_validated_at).toEqual(expect.any(String))
  })

  it('clears on a definitive invalid verdict', () => {
    expect(vatValidationColumns({ valid: false }, 'DE123456789', 'DE123456789')).toEqual({
      vat_number_validated: false,
      vat_number_validated_at: null,
    })
  })

  it('leaves the stored state alone when VIES is unavailable and the number is unchanged', () => {
    expect(
      vatValidationColumns({ valid: false, unavailable: true }, 'FR 40303265045', 'fr40303265045')
    ).toBeNull()
  })

  it('marks a changed number unverified when VIES is unavailable', () => {
    expect(
      vatValidationColumns({ valid: false, unavailable: true }, 'FR40303265045', 'FR12345678901')
    ).toEqual({ vat_number_validated: false, vat_number_validated_at: null })
  })
})
