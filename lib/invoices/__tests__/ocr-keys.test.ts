import { describe, it, expect } from 'vitest'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import {
  MIN_REFERENCE_KEY_DIGITS,
  distinctiveReferenceKeys,
  invoiceReferenceKeys,
  matchesNormalizedReference,
  textMentionsReference,
} from '../ocr-keys'

describe('invoiceReferenceKeys', () => {
  it('returns the bare invoice-number digits and the printed OCR', () => {
    const keys = invoiceReferenceKeys('2026-0042')
    expect(keys).toEqual([
      { key: '20260042', form: 'invoice_number' },
      { key: generateOcrReference('2026-0042'), form: 'ocr' },
    ])
  })

  it('derives the OCR key from the same generator the invoice PDF prints', () => {
    const [, ocr] = invoiceReferenceKeys('F-2024001')
    expect(ocr.key).toBe(generateOcrReference('F-2024001'))
    expect(ocr.key).toBe('20240016')
  })

  it('returns nothing for an invoice number with no digits', () => {
    expect(invoiceReferenceKeys('ABC')).toEqual([])
    expect(invoiceReferenceKeys(null)).toEqual([])
    expect(invoiceReferenceKeys(undefined)).toEqual([])
  })

  it('does not emit a duplicate key when the OCR generator declines the number', () => {
    // 25+ digits: generateOcrReference returns the input unchanged, so the OCR
    // form would normalise to the bare key again.
    const tooLong = '1'.repeat(25)
    expect(invoiceReferenceKeys(tooLong)).toEqual([{ key: tooLong, form: 'invoice_number' }])
  })
})

describe('matchesNormalizedReference', () => {
  it('matches the bare invoice number', () => {
    expect(matchesNormalizedReference('2026-0042', '20260042')).toBe(true)
  })

  it('matches the printed OCR with its check digit', () => {
    expect(matchesNormalizedReference('2026-0042', generateOcrReference('2026-0042'))).toBe(true)
  })

  it('rejects an OCR whose check digit is wrong', () => {
    const ocr = generateOcrReference('2026-0042')
    const wrongCheckDigit = ocr.slice(0, -1) + ((Number(ocr.slice(-1)) + 1) % 10).toString()
    expect(matchesNormalizedReference('2026-0042', wrongCheckDigit)).toBe(false)
  })

  it('rejects an empty reference', () => {
    expect(matchesNormalizedReference('2026-0042', '')).toBe(false)
  })
})

describe('distinctiveReferenceKeys', () => {
  it('keeps both forms when the invoice number is long enough', () => {
    expect(distinctiveReferenceKeys('2026-0042')).toEqual([
      '20260042',
      generateOcrReference('2026-0042'),
    ])
  })

  it('drops keys below the digit floor but keeps the OCR that clears it', () => {
    // "700" is 3 digits (below the floor); its OCR "7004" is 4.
    expect(MIN_REFERENCE_KEY_DIGITS).toBe(4)
    expect(distinctiveReferenceKeys('700')).toEqual([generateOcrReference('700')])
  })

  it('returns nothing when no form clears the floor', () => {
    expect(distinctiveReferenceKeys('7')).toEqual([])
  })
})

describe('textMentionsReference', () => {
  it('rejects a token found inside a longer number', () => {
    // The reported case (#2673): ankomstnummer 14 against a payment voucher
    // that quotes another supplier's invoice number 1814. A plain substring
    // test said yes and settled 859 kr against a 3 500 kr payable.
    expect(textMentionsReference('Levbet Tele2 Sverige AB (1814)', '14')).toBe(false)
    expect(textMentionsReference('Betalning faktura 91814', '1814')).toBe(false)
    expect(textMentionsReference('Avser 20260042001', '20260042')).toBe(false)
  })

  it('accepts a token delimited by anything that is not a digit', () => {
    expect(textMentionsReference('Levbet Tele2 Sverige AB (1814)', '1814')).toBe(true)
    expect(textMentionsReference('Betalning faktura F-9001', 'F-9001')).toBe(true)
    // Whitespace is stripped on both sides, which is why the guard is digit
    // adjacency and not \b: here the token is preceded by a letter.
    expect(textMentionsReference('Faktura 1814', '1814')).toBe(true)
    expect(textMentionsReference('BG inbet 2026 0042', '20260042')).toBe(true)
  })

  it('applies the same digit floor as the OCR keys', () => {
    expect(textMentionsReference('Levbet Tele2 (14)', '14')).toBe(false)
    expect(textMentionsReference('Levbet Tele2 (999)', '999')).toBe(false)
    expect(textMentionsReference('Levbet Tele2 (1000)', '1000')).toBe(true)
  })

  it('is case insensitive and safe with regex metacharacters', () => {
    expect(textMentionsReference('BETALNING F-9001', 'f-9001')).toBe(true)
    expect(textMentionsReference('Faktura A.B*1', 'a.b*1')).toBe(true)
    expect(textMentionsReference('Faktura AXB1', 'a.b*1')).toBe(false)
  })

  it('returns false for empty input on either side', () => {
    expect(textMentionsReference(null, '1814')).toBe(false)
    expect(textMentionsReference('Levbet 1814', null)).toBe(false)
    expect(textMentionsReference('', '1814')).toBe(false)
  })
})
