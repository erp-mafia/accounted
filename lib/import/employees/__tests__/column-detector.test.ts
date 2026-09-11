import { describe, it, expect } from 'vitest'
import { detectEmployeeColumns } from '../column-detector'

describe('detectEmployeeColumns', () => {
  it('detects a Swedish payroll export with first/last name columns', () => {
    const cols = detectEmployeeColumns([
      'Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön',
      'Skattetabell', 'Kolumn', 'Kommun', 'Clearingnummer', 'Kontonummer', 'E-post',
    ])
    expect(cols.first_name_col).toBe(0)
    expect(cols.last_name_col).toBe(1)
    expect(cols.full_name_col).toBeNull()
    expect(cols.personnummer_col).toBe(2)
    expect(cols.employment_start_col).toBe(3)
    expect(cols.monthly_salary_col).toBe(4)
    expect(cols.tax_table_col).toBe(5)
    expect(cols.tax_column_col).toBe(6)
    expect(cols.municipality_col).toBe(7)
    expect(cols.clearing_number_col).toBe(8)
    expect(cols.bank_account_col).toBe(9)
    expect(cols.email_col).toBe(10)
    expect(cols.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('falls back to a combined name column and English headers', () => {
    const cols = detectEmployeeColumns(['Name', 'Personal number', 'Start date', 'Hourly rate'])
    expect(cols.full_name_col).toBe(0)
    expect(cols.first_name_col).toBeNull()
    expect(cols.personnummer_col).toBe(1)
    expect(cols.employment_start_col).toBe(2)
    expect(cols.hourly_rate_col).toBe(3)
  })

  it('claims cutover columns before the generic vacation and salary keywords', () => {
    const cols = detectEmployeeColumns([
      'Namn', 'Personnr', 'Kvarvarande semesterdagar', 'Semesterdagar', 'Ingående bruttolön',
      'Månadslön', 'Ingående skatt', 'Brytdatum',
    ])
    expect(cols.vacation_paid_days_remaining_col).toBe(2)
    expect(cols.vacation_days_col).toBe(3)
    expect(cols.ytd_gross_col).toBe(4)
    expect(cols.monthly_salary_col).toBe(5)
    expect(cols.ytd_tax_col).toBe(6)
    expect(cols.cutover_date_col).toBe(7)
  })

  it('has zero confidence without a personnummer column', () => {
    const cols = detectEmployeeColumns(['Namn', 'Månadslön'])
    expect(cols.personnummer_col).toBeNull()
    expect(cols.confidence).toBe(0)
  })
})
