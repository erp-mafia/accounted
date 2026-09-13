import { describe, expect, it } from 'vitest'
import { isPeppolScheme, normalizePeppolIdentifier } from '@/lib/invoices/peppol-identifiers'

describe('normalizePeppolIdentifier', () => {
  it('reduces a Swedish organisation number (0007) to its ten digits', () => {
    expect(normalizePeppolIdentifier('0007', '5595386219')).toBe('5595386219')
    expect(normalizePeppolIdentifier('0007', '559538-6219')).toBe('5595386219')
    expect(normalizePeppolIdentifier('0007', ' 559538 6219 ')).toBe('5595386219')
    expect(normalizePeppolIdentifier('0007', '165595386219')).toBe('5595386219')
    expect(normalizePeppolIdentifier('0007', '16 559538-6219')).toBe('5595386219')
  })

  it('does not strip a leading 16 unless twelve digits remain', () => {
    expect(normalizePeppolIdentifier('0007', '1655953862')).toBe('1655953862')
    expect(normalizePeppolIdentifier('0007', '1655953862190')).toBe('1655953862190')
  })

  it('only removes whitespace for other schemes', () => {
    expect(normalizePeppolIdentifier('0088', '73 0000 0000 1')).toBe('73000000001')
    expect(normalizePeppolIdentifier('0192', '987 654 321')).toBe('987654321')
    expect(normalizePeppolIdentifier('9915', 'b-AT-1234 ')).toBe('b-AT-1234')
  })

  it('returns an empty string when nothing identifying is left', () => {
    expect(normalizePeppolIdentifier('0007', '--')).toBe('')
    expect(normalizePeppolIdentifier('0088', '   ')).toBe('')
  })
})

describe('isPeppolScheme', () => {
  it('accepts four-digit ICD codes only, whitespace tolerated', () => {
    expect(isPeppolScheme('0007')).toBe(true)
    expect(isPeppolScheme(' 0088 ')).toBe(true)
    expect(isPeppolScheme('SE:ORGNR')).toBe(false)
    expect(isPeppolScheme('07')).toBe(false)
    expect(isPeppolScheme('')).toBe(false)
  })
})
