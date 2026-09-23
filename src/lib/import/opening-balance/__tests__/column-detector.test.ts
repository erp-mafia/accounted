import { describe, it, expect } from 'vitest'
import { detectColumns } from '../column-detector'

describe('detectColumns', () => {
  it('detects Swedish debit/credit headers', () => {
    const headers = ['Kontonr', 'Kontonamn', 'Debet', 'Kredit']
    const dataRows = [
      ['1930', 'Företagskonto', '50000', '0'],
      ['2440', 'Leverantörsskulder', '0', '15000'],
    ]

    const result = detectColumns(headers, dataRows)

    expect(result.account_number_col).toBe(0)
    expect(result.account_name_col).toBe(1)
    expect(result.layout).toBe('debit_credit')
    expect(result.debit_col).toBe(2)
    expect(result.credit_col).toBe(3)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('detects net balance layout', () => {
    const headers = ['Konto', 'Namn', 'Saldo']
    const dataRows = [
      ['1930', 'Företagskonto', '50000'],
      ['2440', 'Leverantörsskulder', '-15000'],
    ]

    const result = detectColumns(headers, dataRows)

    expect(result.account_number_col).toBe(0)
    expect(result.layout).toBe('net')
    expect(result.balance_col).toBe(2)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('detects English headers', () => {
    const headers = ['Account Number', 'Account Name', 'Debit', 'Credit']
    const dataRows = [
      ['1930', 'Business account', '50000', '0'],
    ]

    const result = detectColumns(headers, dataRows)

    expect(result.account_number_col).toBe(0)
    expect(result.account_name_col).toBe(1)
    expect(result.layout).toBe('debit_credit')
  })

  it('falls back to data analysis when no headers match', () => {
    const headers = ['Col A', 'Col B', 'Col C']
    const dataRows = [
      ['1930', 'Something', '50000'],
      ['2440', 'Other', '15000'],
      ['1510', 'Third', '8000'],
    ]

    const result = detectColumns(headers, dataRows)

    // Should detect column 0 as account numbers (4-digit pattern)
    expect(result.account_number_col).toBe(0)
    // Column 2 should be detected as numeric
    expect(result.balance_col).not.toBeNull()
  })

  it('returns low confidence when nothing is detected', () => {
    const headers = ['X', 'Y', 'Z']
    const dataRows = [
      ['abc', 'def', 'ghi'],
    ]

    const result = detectColumns(headers, dataRows)

    expect(result.confidence).toBeLessThan(0.5)
  })

  it('detects IB keyword as balance column', () => {
    const headers = ['Konto', 'IB', 'UB']
    const dataRows = [
      ['1930', '50000', '55000'],
    ]

    const result = detectColumns(headers, dataRows)

    expect(result.account_number_col).toBe(0)
    expect(result.layout).toBe('net')
    expect(result.balance_col).toBe(1)
  })

  it('handles empty data rows', () => {
    const headers = ['Kontonr', 'Debet', 'Kredit']
    const dataRows: string[][] = []

    const result = detectColumns(headers, dataRows)

    expect(result.account_number_col).toBe(0)
    expect(result.layout).toBe('debit_credit')
  })
})
