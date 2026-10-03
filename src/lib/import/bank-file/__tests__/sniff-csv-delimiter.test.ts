/**
 * sniffCSVDelimiter: the delimiter the manual column-mapping step opens with.
 *
 * Regression guard: prepareContent drops Excel's `sep=` hint line, so the old
 * sniff (which split the RAW first line, i.e. the hint itself) scored every
 * candidate 0 and fell back to ',' for an Excel-saved semicolon file.
 */

import { describe, expect, it } from 'vitest'
import { getCSVPreview, sniffCSVDelimiter } from '../formats/generic-csv'

describe('sniffCSVDelimiter', () => {
  it('honours an Excel sep=; hint and leaves the real header as row 0', () => {
    const content = 'sep=;\nDatum;Text;Belopp\n2026-01-15;SPOTIFY;-99,00\n2026-01-16;ICA;-432,50'
    const delimiter = sniffCSVDelimiter(content)
    expect(delimiter).toBe(';')
    // The mapping step's header-row scan runs over this preview: the header
    // is row 0, so it lands there and skip_rows comes out as 1.
    const rows = getCSVPreview(content, delimiter, 30)
    expect(rows[0]).toEqual(['Datum', 'Text', 'Belopp'])
    expect(rows[1]).toEqual(['2026-01-15', 'SPOTIFY', '-99,00'])
    expect(rows).toHaveLength(3)
  })

  it('reads a quoted hint behind a BOM with CRLF line endings', () => {
    expect(sniffCSVDelimiter('﻿"sep=;"\r\nDatum;Text;Belopp\r\n2026-01-15;SPOTIFY;-99,00')).toBe(';')
  })

  it('lets the hint decide when the first line alone is ambiguous', () => {
    // Unquoted commas inside the labels split it into as many cells as ';'
    // does, and the tie would go to ','.
    const header = 'Datum;Text, fri;Belopp, kr;Saldo, kr'
    expect(sniffCSVDelimiter(header + '\n2026-01-15;SPOTIFY;-99,00;100,00')).toBe(',')
    expect(sniffCSVDelimiter('sep=;\n' + header + '\n2026-01-15;SPOTIFY;-99,00;100,00')).toBe(';')
  })

  it('falls back to scoring when the hint names a delimiter the mapper does not offer', () => {
    expect(sniffCSVDelimiter('sep=|\nDatum;Text;Belopp\n2026-01-15;SPOTIFY;-99,00')).toBe(';')
  })

  it('sniffs a plain semicolon file', () => {
    expect(sniffCSVDelimiter('Datum;Text;Belopp;Saldo\n2026-01-15;SPOTIFY;-99,00;12345,67')).toBe(';')
  })

  it('sniffs a plain comma file', () => {
    expect(sniffCSVDelimiter('Datum,Text,Belopp,Saldo\n2026-01-15,SPOTIFY,"-99,00","12345,67"')).toBe(',')
  })

  it('sniffs a tab-separated file', () => {
    expect(sniffCSVDelimiter('Datum\tText\tBelopp\n2026-01-15\tSPOTIFY\t-99,00')).toBe('\t')
  })

  it('falls back to a comma when nothing splits the first line', () => {
    expect(sniffCSVDelimiter('')).toBe(',')
    expect(sniffCSVDelimiter('Kontoutdrag')).toBe(',')
  })

  it('still honours the hint in a file that is nothing but the hint', () => {
    expect(sniffCSVDelimiter('sep=;')).toBe(';')
  })
})
