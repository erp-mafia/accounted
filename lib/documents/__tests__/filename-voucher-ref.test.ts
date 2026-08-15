import { describe, it, expect } from 'vitest'
import { parseVoucherRefFromFileName } from '@/lib/documents/filename-voucher-ref'

describe('parseVoucherRefFromFileName', () => {
  it('parses the SpeedLedger prefix form (series + number + internal id)', () => {
    expect(parseVoucherRefFromFileName('A31_8c2db060-79ba-4b6e-9f3d-4b0042aa5c52.pdf')).toEqual({
      series: 'A',
      number: 31,
      pattern: 'series_number',
      autoSelectable: true,
    })
  })

  it('parses a bare series + number filename', () => {
    expect(parseVoucherRefFromFileName('V123.pdf')).toMatchObject({ series: 'V', number: 123 })
  })

  it.each([
    ['A-31 kvitto.pdf', 'A', 31],
    ['A_31.jpg', 'A', 31],
    ['A 31 leverantorsfaktura.png', 'A', 31],
    ['2024-A-31.pdf', 'A', 31],
    ['2024_A31_underlag.pdf', 'A', 31],
    ['ver_A31.pdf', 'A', 31],
    ['Verifikat A31.pdf', 'A', 31],
    ['BC7.pdf', 'BC', 7],
  ])('parses %s', (fileName, series, number) => {
    expect(parseVoucherRefFromFileName(fileName)).toMatchObject({ series, number })
  })

  it('uppercases the series so a lowercase export still joins', () => {
    expect(parseVoucherRefFromFileName('a31_x.pdf')).toMatchObject({ series: 'A' })
  })

  it.each([
    // Paper sizes: every scanner emits an A4.pdf.
    'A4.pdf',
    'A4 scan.pdf',
    'a4.pdf',
    'A3 ritning.pdf',
    // A batch scanner's zero-padded counter normalizes onto the same refs.
    'A0004.pdf',
    'A001.pdf',
    // Skatteverket blanketter and quarters.
    'K10.pdf',
    'K10 blankett 2024.pdf',
    'K4.pdf',
    'N9.pdf',
    'Q1 2024.pdf',
  ])('parses %s but never pre-selects it: more often a document name than a ref', (fileName) => {
    const parsed = parseVoucherRefFromFileName(fileName)
    expect(parsed).not.toBeNull()
    expect(parsed?.autoSelectable).toBe(false)
  })

  it.each(['IMG_0031.jpg', 'DSC00123.JPG', 'DOC001.pdf', 'SCN0007.pdf', 'Del 1 av 3.pdf'])(
    'parses %s but never pre-selects a three-letter series: cameras, not ledgers',
    (fileName) => {
      const parsed = parseVoucherRefFromFileName(fileName)
      expect(parsed).not.toBeNull()
      expect(parsed?.autoSelectable).toBe(false)
    },
  )

  it.each([
    ['A7.pdf', 'A', 7],
    ['A31.pdf', 'A', 31],
    ['K1.pdf', 'K', 1],
    ['K14.pdf', 'K', 14],
    ['LB2.pdf', 'LB', 2],
  ])('keeps %s auto-selectable: just outside the collision list', (fileName, series, number) => {
    expect(parseVoucherRefFromFileName(fileName)).toEqual({
      series,
      number,
      pattern: 'series_number',
      autoSelectable: true,
    })
  })

  it.each([
    'underlag/2024/A31_kvitto.pdf',
    'underlag\\A31.pdf',
    // The manual-reference box feeds arbitrary typed text through this same
    // parser. Splitting on the separator would turn a typed date into a
    // voucher number and hand the user an irreversible link to approve.
    '2024/01/31 kvitto.pdf',
    '2024/01/31',
  ])('does not strip a path component out of %s', (input) => {
    expect(parseVoucherRefFromFileName(input)).toBeNull()
  })

  it.each([
    ['Verifikation 31.pdf', 31],
    ['verifikation31.pdf', 31],
    ['Verifikat 31.pdf', 31],
    // `ver` is a prefix word, not a series: without that rule this one form
    // came back auto-selectable while every spelled-out variant did not.
    ['ver 31.pdf', 31],
    ['ver31.pdf', 31],
    ['VER-31.pdf', 31],
    ['ver.31.pdf', 31],
  ])('reads %s as a series-less reference, not a bogus series', (fileName, number) => {
    expect(parseVoucherRefFromFileName(fileName)).toEqual({
      series: null,
      number,
      pattern: 'number_only',
      autoSelectable: false,
    })
  })

  it('returns a series-less parse for a number-only name, never auto-selectable', () => {
    expect(parseVoucherRefFromFileName('31.pdf')).toEqual({
      series: null,
      number: 31,
      pattern: 'number_only',
      autoSelectable: false,
    })
    expect(parseVoucherRefFromFileName('31_kvitto.pdf')).toMatchObject({ series: null, number: 31 })
  })

  it.each([
    '20240131.pdf',
    '20240131_kvitto.pdf',
    '2024-01-31 kvitto.pdf',
    '2024_01_31.pdf',
    // Unpadded components, two-digit years and space separators are just as
    // common in receipt exports and used to slip through as voucher 2024 / 24.
    '2024-1-31 kvitto.pdf',
    '2024_1_31.pdf',
    '2024.1.31.pdf',
    '2024 01 31 kvitto.pdf',
    '24-01-31 kvitto.pdf',
    '2024/01/31.pdf',
    // Day-first and US order: the day would otherwise become a voucher number
    // that always exists in the year.
    '31.01.2024.pdf',
    '31-01-2024.pdf',
    '31_01_2024.pdf',
    '31.1.2024.pdf',
    '24.12.2024 julbord.pdf',
    '03.04.2025 ICA.pdf',
    '12.24.2024.pdf',
    '01-31-2024.pdf',
    '1-31-2024 receipt.pdf',
    '31/1/2024.pdf',
  ])('refuses the date-named file %s rather than reading it as a number', (fileName) => {
    expect(parseVoucherRefFromFileName(fileName)).toBeNull()
  })

  it.each(['2024.pdf', '2024_kvitto.pdf', '1999.pdf'])(
    'refuses the year-shaped series-less name %s',
    (fileName) => {
      expect(parseVoucherRefFromFileName(fileName)).toBeNull()
    },
  )

  it.each([
    'kvitto.pdf',
    'Faktura2024.pdf',
    'A31kvitto.pdf',
    'Version2_kvitto.pdf',
    '',
    '.pdf',
  ])('returns null for %s instead of guessing', (fileName) => {
    expect(parseVoucherRefFromFileName(fileName)).toBeNull()
  })

  it('rejects a zero voucher number', () => {
    expect(parseVoucherRefFromFileName('A0.pdf')).toBeNull()
    expect(parseVoucherRefFromFileName('0.pdf')).toBeNull()
  })

  it('handles a filename with no extension at all', () => {
    expect(parseVoucherRefFromFileName('A31_8c2db060-79ba-4b6e-9f3d-4b0042aa5c52')).toMatchObject({
      series: 'A',
      number: 31,
    })
  })
})
