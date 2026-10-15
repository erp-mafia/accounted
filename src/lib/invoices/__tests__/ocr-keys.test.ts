import { describe, it, expect } from 'vitest'
import { generateLengthDigitOcrReference, generateOcrReference } from '@/lib/bankgiro/luhn'
import {
  MIN_REFERENCE_KEY_DIGITS,
  distinctiveReferenceKeys,
  invoiceReferenceKeys,
  invoicesNamedByReference,
  invoicesNamedInTiers,
} from '../ocr-keys'

describe('invoiceReferenceKeys', () => {
  it('returns the bare invoice-number digits, the printed OCR and the length-digit OCR', () => {
    const keys = invoiceReferenceKeys('2026-0042')
    expect(keys).toEqual([
      { key: '20260042', form: 'invoice_number' },
      { key: generateOcrReference('2026-0042'), form: 'ocr' },
      { key: generateLengthDigitOcrReference('2026-0042'), form: 'ocr_length' },
    ])
  })

  it('derives the OCR key from the same generator the invoice PDF prints', () => {
    const [, ocr] = invoiceReferenceKeys('F-2024001')
    expect(ocr.key).toBe(generateOcrReference('F-2024001'))
    expect(ocr.key).toBe('20240016')
  })

  it('hands every caller its own array, so a caller changing it changes no other', () => {
    const first = invoiceReferenceKeys('316')
    first.pop()
    expect(invoiceReferenceKeys('316').map((k) => k.key)).toEqual(['316', '3160', '31658'])
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

describe('invoicesNamedInTiers', () => {
  it('returns what the strongest tier that names anything names, and asks the weaker tier only then', () => {
    const asked: string[][] = []
    const named = invoicesNamedInTiers(['a', 'b', 'c'], (invoice, forms) => {
      asked.push([invoice, ...forms])
      return forms.includes('ocr_length') ? invoice !== 'a' : invoice === 'a'
    })
    expect(named).toEqual(['a'])
    expect(asked.every(([, ...forms]) => !forms.includes('ocr_length'))).toBe(true)
    expect(invoicesNamedInTiers(['a', 'b', 'c'], (invoice, forms) => forms.includes('ocr_length') && invoice !== 'a')).toEqual(['b', 'c'])
    expect(invoicesNamedInTiers(['a'], () => false)).toEqual([])
  })
})

describe('invoicesNamedByReference', () => {
  const inv = (id: string, invoice_number: string | null) => ({ id, invoice_number })
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id)
  const f42 = inv('f42', '2026-0042')
  const i316 = inv('i316', '316')

  it('names an invoice by its bare number', () => {
    expect(ids(invoicesNamedByReference([f42], '20260042'))).toEqual(['f42'])
  })

  it('names an invoice by the printed OCR with its check digit', () => {
    expect(ids(invoicesNamedByReference([f42], generateOcrReference('2026-0042')))).toEqual(['f42'])
  })

  it("names an invoice by Bankgirot's length-digit OCR (316 -> 31658)", () => {
    expect(ids(invoicesNamedByReference([i316], '31658'))).toEqual(['i316'])
  })

  it('rejects an OCR whose check digit is wrong, in either form', () => {
    const ocr = generateOcrReference('2026-0042')
    const wrongCheckDigit = ocr.slice(0, -1) + ((Number(ocr.slice(-1)) + 1) % 10).toString()
    expect(invoicesNamedByReference([f42], wrongCheckDigit)).toEqual([])
    expect(invoicesNamedByReference([i316], '31659')).toEqual([])
  })

  it('rejects a length-digit OCR whose length digit is wrong, even with a valid check digit', () => {
    // 3164 + Luhn 1: a valid OCR, but 4 is not its length of 5.
    expect(invoicesNamedByReference([i316], '31641')).toEqual([])
  })

  it('never matches a part of a reference or a reference with digits around it', () => {
    expect(invoicesNamedByReference([i316], '1658')).toEqual([])
    expect(invoicesNamedByReference([i316], '316580')).toEqual([])
    expect(invoicesNamedByReference([i316], '131658')).toEqual([])
  })

  it("reads the length-digit form only when no invoice is named the older ways", () => {
    // 31658 is invoice 31658's own number and invoice 316's length-digit OCR.
    const i31658 = inv('i31658', '31658')
    expect(ids(invoicesNamedByReference([i316, i31658], '31658'))).toEqual(['i31658'])
    // Several references at once: the older forms of any one outrank the
    // length-digit form of another.
    expect(ids(invoicesNamedByReference([i316, f42], ['31658', '20260042']))).toEqual(['f42'])
    expect(ids(invoicesNamedByReference([i316, f42], ['31658', '99999']))).toEqual(['i316'])
  })

  it('keeps the order of the invoices it was given', () => {
    const twin = inv('twin', 'F-316')
    expect(ids(invoicesNamedByReference([twin, i316], '316'))).toEqual(['twin', 'i316'])
  })

  it('names nothing for an empty reference or an invoice without digits', () => {
    expect(invoicesNamedByReference([f42], '')).toEqual([])
    expect(invoicesNamedByReference([f42], [])).toEqual([])
    expect(invoicesNamedByReference([inv('none', null), inv('abc', 'ABC')], '1')).toEqual([])
  })
})

describe('distinctiveReferenceKeys', () => {
  it('keeps every form when the invoice number is long enough, or the forms asked for', () => {
    expect(distinctiveReferenceKeys('2026-0042')).toEqual([
      '20260042',
      generateOcrReference('2026-0042'),
      generateLengthDigitOcrReference('2026-0042'),
    ])
    expect(distinctiveReferenceKeys('2026-0042', ['invoice_number', 'ocr'])).toEqual(['20260042', generateOcrReference('2026-0042')])
    expect(distinctiveReferenceKeys('2026-0042', ['ocr_length'])).toEqual([generateLengthDigitOcrReference('2026-0042')])
  })

  it('drops keys below the digit floor but keeps the OCRs that clear it', () => {
    // "700" is 3 digits (below the floor); its OCR "7005" is 4, its length-digit OCR "70052" is 5.
    expect(MIN_REFERENCE_KEY_DIGITS).toBe(4)
    expect(distinctiveReferenceKeys('700')).toEqual(['7005', '70052'])
  })

  it('returns nothing when no form clears the floor', () => {
    // "7": bare 7, OCR 75, length-digit OCR 737: all below four digits.
    expect(invoiceReferenceKeys('7').map((k) => k.key)).toEqual(['7', '75', '737'])
    expect(distinctiveReferenceKeys('7')).toEqual([])
  })
})
