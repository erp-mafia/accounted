import { describe, it, expect } from 'vitest'
import { normalizeDate } from '../date-utils'

describe('normalizeDate', () => {
  // Pass-through for canonical format
  it('passes through YYYY-MM-DD', () => {
    expect(normalizeDate('2024-01-15')).toBe('2024-01-15')
    expect(normalizeDate('2026-12-31')).toBe('2026-12-31')
  })

  // European dot format
  it('normalizes DD.MM.YYYY', () => {
    expect(normalizeDate('15.01.2024')).toBe('2024-01-15')
    expect(normalizeDate('31.12.2026')).toBe('2026-12-31')
  })

  it('normalizes D.M.YYYY (single-digit day/month)', () => {
    expect(normalizeDate('5.1.2024')).toBe('2024-01-05')
    expect(normalizeDate('9.3.2025')).toBe('2025-03-09')
  })

  // European slash format
  it('normalizes DD/MM/YYYY', () => {
    expect(normalizeDate('15/01/2024')).toBe('2024-01-15')
    expect(normalizeDate('31/12/2026')).toBe('2026-12-31')
  })

  it('normalizes D/M/YYYY (single-digit)', () => {
    expect(normalizeDate('5/1/2024')).toBe('2024-01-05')
  })

  // US format with hint
  it('normalizes MM/DD/YYYY when hint is provided', () => {
    expect(normalizeDate('01/15/2024', 'MM/DD/YYYY')).toBe('2024-01-15')
    expect(normalizeDate('12/31/2026', 'MM/DD/YYYY')).toBe('2026-12-31')
  })

  // Compact format
  it('normalizes YYYYMMDD', () => {
    expect(normalizeDate('20240115')).toBe('2024-01-15')
    expect(normalizeDate('20261231')).toBe('2026-12-31')
  })

  // Slash year-first format
  it('normalizes YYYY/MM/DD', () => {
    expect(normalizeDate('2024/01/15')).toBe('2024-01-15')
    expect(normalizeDate('2026/12/31')).toBe('2026-12-31')
  })

  // Whitespace handling
  it('trims whitespace', () => {
    expect(normalizeDate(' 2024-01-15 ')).toBe('2024-01-15')
    expect(normalizeDate('  15.01.2024  ')).toBe('2024-01-15')
  })

  // Invalid dates
  it('returns null for empty/null/undefined', () => {
    expect(normalizeDate('')).toBeNull()
    expect(normalizeDate(null)).toBeNull()
    expect(normalizeDate(undefined)).toBeNull()
    expect(normalizeDate('   ')).toBeNull()
  })

  it('returns null for unrecognized formats', () => {
    expect(normalizeDate('Jan 15, 2024')).toBeNull()
    expect(normalizeDate('15-Jan-2024')).toBeNull()
    expect(normalizeDate('abc')).toBeNull()
    expect(normalizeDate('2024')).toBeNull()
  })

  it('returns null for invalid month', () => {
    expect(normalizeDate('2024-13-01')).toBeNull()
    expect(normalizeDate('2024-00-01')).toBeNull()
  })

  it('returns null for invalid day', () => {
    expect(normalizeDate('2024-02-30')).toBeNull() // Feb 30 doesn't exist
    expect(normalizeDate('2024-04-31')).toBeNull() // Apr has 30 days
    expect(normalizeDate('2024-01-32')).toBeNull()
    expect(normalizeDate('2024-01-00')).toBeNull()
  })

  it('handles leap year correctly', () => {
    expect(normalizeDate('2024-02-29')).toBe('2024-02-29') // 2024 is leap year
    expect(normalizeDate('2023-02-29')).toBeNull() // 2023 is not
  })

  it('returns null for years out of range', () => {
    expect(normalizeDate('1899-01-01')).toBeNull()
    expect(normalizeDate('2101-01-01')).toBeNull()
  })
})
