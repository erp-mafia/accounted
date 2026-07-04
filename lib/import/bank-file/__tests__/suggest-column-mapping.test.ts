/**
 * Tests for suggestColumnMapping: the auto-guess that seeds the manual CSV
 * column-mapping UI.
 *
 * Regression context: the previous heuristic walked each data row right-to-left
 * and picked the first numeric cell as the amount. Because virtually every
 * Swedish bank export ends with `…;Belopp;Saldo`, that grabbed the trailing
 * running-balance column as the amount, so the live preview showed the balance
 * instead of the transaction amount. The fix matches header labels first.
 */

import { describe, it, expect } from 'vitest'
import { suggestColumnMapping } from '../formats/generic-csv'

describe('suggestColumnMapping', () => {
  it('REGRESSION: picks Belopp (not the trailing Saldo) as amount when a header is present', () => {
    // Handelsbanken Företag-style layout: Bokföringsdatum;Referens;Belopp;Saldo.
    // The old reverse-scan heuristic would have returned amount = 3 (Saldo).
    const headers = ['Bokföringsdatum', 'Referens', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', 'Swish Anna Svensson', '-99,00', '12345,67'],
      ['2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
      ['2024-01-13', 'LÖNEUTBETALNING', '25000,00', '12877,17'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2) // Belopp, NOT 3 (Saldo)
    expect(result.balance).toBe(3) // Saldo auto-filled
    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
  })

  it('without a header, prefers the column with negative values as amount and the trailing column as balance', () => {
    // date ; text ; belopp ; saldo: no header row at all.
    const dataRows = [
      ['2024-01-15', 'Swish Anna Svensson', '-99,00', '12345,67'],
      ['2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
      ['2024-01-13', 'LÖNEUTBETALNING', '25000,00', '12877,17'],
    ]

    const result = suggestColumnMapping(null, dataRows)

    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
    expect(result.amount).toBe(2) // has negative values
    expect(result.balance).toBe(3) // remaining (all-positive) numeric column
  })

  it('handles the Handelsbanken private layout (Reskontra + Transaktionsdatum + Text)', () => {
    const headers = ['Reskontradatum', 'Transaktionsdatum', 'Text', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', '2024-01-15', 'SPOTIFY AB', '-99,00', '12345,67'],
      ['2024-01-14', '2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(1) // prefers transaktionsdatum over reskontradatum
    expect(result.description).toBe(2) // Text
    expect(result.amount).toBe(3) // Belopp, NOT 4 (Saldo)
    expect(result.balance).toBe(4)
  })

  it('does not invent a balance column when the file has none', () => {
    const headers = ['Datum', 'Text', 'Belopp']
    const dataRows = [
      ['2024-01-15', 'SPOTIFY', '-99,00'],
      ['2024-01-14', 'HEMKÖP', '-432,50'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
    expect(result.amount).toBe(2)
    expect(result.balance).toBe(-1)
  })

  it('matches the amount by label even when every amount is positive', () => {
    // No negative values to fall back on: the label match must still win.
    const headers = ['Bokföringsdatum', 'Referens', 'Belopp', 'Saldo']
    const dataRows = [['2024-01-15', 'Inbetalning kund', '5000,00', '12345,67']]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2) // Belopp by label, not Saldo
    expect(result.balance).toBe(3)
  })

  it('tolerates space-grouped thousands and Unicode minus signs', () => {
    const headers = ['Datum', 'Text', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', 'STOR BETALNING', '−1 432,50', '120 000,00'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2)
    expect(result.balance).toBe(3)
  })

  it('returns all -1 for empty input', () => {
    expect(suggestColumnMapping(null, [])).toEqual({ date: -1, description: -1, amount: -1, balance: -1 })
  })
})
