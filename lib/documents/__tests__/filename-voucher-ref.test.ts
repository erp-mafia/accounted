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

  it('drops a directory prefix from a dropped folder', () => {
    expect(parseVoucherRefFromFileName('underlag/2024/A31_kvitto.pdf')).toMatchObject({
      series: 'A',
      number: 31,
    })
    expect(parseVoucherRefFromFileName('underlag\\A31.pdf')).toMatchObject({ series: 'A' })
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
  ])('refuses the date-named file %s rather than reading it as a number', (fileName) => {
    expect(parseVoucherRefFromFileName(fileName)).toBeNull()
  })

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
