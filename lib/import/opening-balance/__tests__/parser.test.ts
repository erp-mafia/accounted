import { describe, it, expect, vi } from 'vitest'
import { parseAmount } from '../parser'

// Mock the BAS reference for consistent testing
vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: (accountNumber: string) => {
    const accounts: Record<string, { account_name: string }> = {
      '1930': { account_name: 'Företagskonto / checkkonto / affärskonto' },
      '2440': { account_name: 'Leverantörsskulder' },
      '1510': { account_name: 'Kundfordringar' },
      '2099': { account_name: 'Årets resultat' },
    }
    return accounts[accountNumber] ? { ...accounts[accountNumber], account_number: accountNumber } : null
  },
}))

describe('parseAmount', () => {
  it('handles numbers', () => {
    expect(parseAmount(50000)).toBe(50000)
    expect(parseAmount(123.456)).toBe(123.46)
  })

  it('handles Swedish decimal commas', () => {
    expect(parseAmount('50 000,00')).toBe(50000)
    expect(parseAmount('1 234,56')).toBe(1234.56)
  })

  it('handles strings with dots as thousand separators', () => {
    expect(parseAmount('50.000,00')).toBe(50000)
  })

  it('handles plain strings', () => {
    expect(parseAmount('50000')).toBe(50000)
    expect(parseAmount('-15000')).toBe(-15000)
  })

  it('handles empty/null/undefined', () => {
    expect(parseAmount(null)).toBe(0)
    expect(parseAmount(undefined)).toBe(0)
    expect(parseAmount('')).toBe(0)
    expect(parseAmount('-')).toBe(0)
  })

  it('rounds to 2 decimal places', () => {
    expect(parseAmount(0.1 + 0.2)).toBe(0.3)
  })
})

describe('parseOpeningBalanceFile', () => {
  // We can't easily test the full parser without creating actual Excel buffers,
  // but we can test via the xlsx library's ability to create workbooks in memory
  it('is importable', async () => {
    const { parseOpeningBalanceFile } = await import('../parser')
    expect(typeof parseOpeningBalanceFile).toBe('function')
  })

  it('parses a simple CSV-like workbook', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    // Create a workbook in memory
    const wb = XLSX.utils.book_new()
    const data = [
      ['Kontonr', 'Kontonamn', 'Debet', 'Kredit'],
      ['1930', 'Företagskonto', 50000, 0],
      ['2440', 'Leverantörsskulder', 0, 15000],
      ['1510', 'Kundfordringar', 10000, 0],
      ['2099', 'Årets resultat', 0, 45000],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Balans')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    expect(result.filename).toBe('test.xlsx')
    expect(result.sheet_name).toBe('Balans')
    expect(result.rows.length).toBe(4)
    expect(result.total_debit).toBe(60000)
    expect(result.total_credit).toBe(60000)
    expect(result.is_balanced).toBe(true)

    // Check first row
    const row1930 = result.rows.find((r) => r.account_number === '1930')
    expect(row1930).toBeDefined()
    expect(row1930!.debit_amount).toBe(50000)
    expect(row1930!.credit_amount).toBe(0)
    expect(row1930!.bas_match).toBeTruthy()
  })

  it('handles net balance layout', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    const data = [
      ['Konto', 'Saldo'],
      ['1930', 50000],
      ['2440', -15000],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    expect(result.rows.length).toBe(2)

    const row1930 = result.rows.find((r) => r.account_number === '1930')
    expect(row1930!.debit_amount).toBe(50000)
    expect(row1930!.credit_amount).toBe(0)

    const row2440 = result.rows.find((r) => r.account_number === '2440')
    expect(row2440!.debit_amount).toBe(0)
    expect(row2440!.credit_amount).toBe(15000)
  })

  it('warns about P&L accounts (class 3-8)', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['1930', 50000, 0],
      ['3001', 0, 50000], // Revenue account: should warn
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    const revenueRow = result.rows.find((r) => r.account_number === '3001')
    expect(revenueRow).toBeDefined()
    expect(revenueRow!.validation_errors.length).toBeGreaterThan(0)
    expect(revenueRow!.validation_errors[0]).toContain('resultatkonto')
  })

  it('merges duplicate account rows', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['1930', 30000, 0],
      ['1930', 20000, 0],
      ['2099', 0, 50000],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    // Should merge duplicates
    const row1930 = result.rows.find((r) => r.account_number === '1930')
    expect(row1930!.debit_amount).toBe(50000)
    expect(result.rows.length).toBe(2) // 1930 (merged) + 2099
    expect(result.warnings.some((w) => w.includes('1930'))).toBe(true)
  })

  it('preserves validation_errors from every duplicated row when merging', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    // Two rows for account 3001 (a P&L class warning fires on each) plus a
    // balance-sheet row to keep totals reachable. Both copies of 3001 should
    // contribute their warning into the merged row's validation_errors so it
    // isn't silently lost.
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['3001', 100, 0],
      ['3001', 200, 0],
      ['2099', 0, 300],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    const merged = result.rows.find((r) => r.account_number === '3001')
    expect(merged).toBeDefined()
    expect(merged!.debit_amount).toBe(300)
    expect(merged!.validation_errors.length).toBeGreaterThan(0)
    expect(merged!.validation_errors.some((e) => e.includes('resultatkonto'))).toBe(true)
  })

  it('merges duplicates that differ only in whitespace / formatting', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    // Same account written three ways: plain, padded with NBSP, with a dot
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['1930', 10000, 0],
      [' 1930 ', 20000, 0],
      ['1.930', 30000, 0],
      ['2099', 0, 60000],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    const matches = result.rows.filter((r) => r.account_number === '1930')
    expect(matches.length).toBe(1)
    expect(matches[0].debit_amount).toBe(60000)
    expect(result.rows.length).toBe(2)
  })

  it('skips zero-amount rows', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['1930', 50000, 0],
      ['1510', 0, 0], // Should be skipped
      ['2099', 0, 50000],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    expect(result.rows.length).toBe(2) // 1930 + 2099 (1510 skipped)
  })

  it('detects unbalanced entries', async () => {
    const XLSX = await import('xlsx')
    const { parseOpeningBalanceFile } = await import('../parser')

    const wb = XLSX.utils.book_new()
    const data = [
      ['Kontonr', 'Debet', 'Kredit'],
      ['1930', 50000, 0],
      ['2099', 0, 40000], // Deliberately unbalanced
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const result = parseOpeningBalanceFile(buffer, 'test.xlsx')

    expect(result.is_balanced).toBe(false)
    expect(result.total_debit).toBe(50000)
    expect(result.total_credit).toBe(40000)
  })
})
