import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseEmployeesFile, splitFullName } from '../parser'

// Synthetic, Luhn-valid 12-digit values with 1900-era birth years: obviously
// not real people (ISO A.5.34 / GDPR Art. 5(1)(c) on fixtures).
const PNR_A = '190001010008'
const PNR_B = '190203040001'
const PNR_C = '190506070002'
const PNR_1930 = '193001010002'

const NOW = new Date('2026-09-11T10:00:00Z')

function buildXlsx(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Anställda')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function buildCsv(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

describe('splitFullName', () => {
  it('splits on the last space so double first names survive', () => {
    expect(splitFullName('Anna Maria Svensson')).toEqual({ first_name: 'Anna Maria', last_name: 'Svensson' })
  })
  it('leaves the last name empty for a single token', () => {
    expect(splitFullName('Madonna')).toEqual({ first_name: 'Madonna', last_name: '' })
  })
})

describe('parseEmployeesFile', () => {
  it('parses a monthly-salaried register and derives the tax column from age', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Skattetabell', 'Kommun', 'Clearingnummer', 'Kontonummer', 'E-post'],
      ['Test', 'Personson', PNR_A, '2026-02-01', '45 000', 33, 'Umeå', '3300', '1234567890', 'test@example.com'],
    ])

    const result = parseEmployeesFile(buffer, 'anstallda.xlsx', undefined, { now: NOW })

    expect(result.total_rows).toBe(1)
    const row = result.rows[0]
    expect(row.employee.first_name).toBe('Test')
    expect(row.employee.last_name).toBe('Personson')
    expect(row.employee.personnummer).toBe(PNR_A)
    expect(row.personnummer_masked).toBe('19000101-XXXX')
    expect(row.employee.employment_start).toBe('2026-02-01')
    expect(row.employee.salary_type).toBe('monthly')
    expect(row.employee.monthly_salary).toBe(45000)
    expect(row.employee.tax_table_number).toBe(33)
    // Born 1900: 66+ at the start of 2026, so the column is not derived.
    expect(row.employee.tax_column).toBe(1)
    expect(row.employee.clearing_number).toBe('3300')
    expect(row.employee.email).toBe('test@example.com')
    expect(row.employee.vacation_days_per_year).toBe(25)
    expect(row.employee.hours_per_week).toBe(40)
    expect(row.opening_balances).toBeNull()
    expect(row.is_valid, row.validation_errors.join('; ')).toBe(true)
  })

  it('infers hourly pay from a timlön column and splits a combined name', () => {
    const buffer = buildXlsx([
      ['Namn', 'Personnr', 'Anställd sedan', 'Timlön', 'Skattetabell', 'Kommun'],
      ['Anna Maria Testsson', PNR_B, '2025-08-15', '185,50', '31', 'Luleå'],
    ])

    const result = parseEmployeesFile(buffer, 'timanstallda.xlsx', undefined, { now: NOW })
    const row = result.rows[0]
    expect(row.employee.first_name).toBe('Anna Maria')
    expect(row.employee.last_name).toBe('Testsson')
    expect(row.employee.salary_type).toBe('hourly')
    expect(row.employee.hourly_rate).toBe(185.5)
    expect(row.employee.monthly_salary).toBeUndefined()
    expect(row.is_valid, row.validation_errors.join('; ')).toBe(true)
  })

  it('lets an explicit löneform column win over the amount heuristic', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Löneform', 'Månadslön', 'Timlön', 'Skattetabell', 'Kommun'],
      ['Test', 'Personson', PNR_A, '2026-01-01', 'Timlön', '', '200', '30', 'Umeå'],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows[0].employee.salary_type).toBe('hourly')
    expect(result.rows[0].employee.hourly_rate).toBe(200)
  })

  it('expands a 10-digit personnummer and flags a bad checksum', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Skattetabell', 'Kommun'],
      ['Test', 'Personson', '300101-0002', '2026-01-01', 30000, 30, 'Umeå'],
      ['Fel', 'Kontroll', '190001010009', '2026-01-01', 30000, 30, 'Umeå'],
      ['Kort', 'Nummer', '12345', '2026-01-01', 30000, 30, 'Umeå'],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows[0].employee.personnummer).toBe(PNR_1930)
    expect(result.rows[0].is_valid).toBe(true)
    expect(result.rows[1].is_valid).toBe(false)
    expect(result.rows[1].validation_errors.join(' ')).toMatch(/Luhn/)
    expect(result.rows[2].is_valid).toBe(false)
    expect(result.rows[2].validation_errors.join(' ')).toMatch(/10 eller 12 siffror/)
  })

  it('fails a row that gives a tax table but no kommun, like the dialog would', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Skattetabell'],
      ['Test', 'Personson', PNR_A, '2026-01-01', 30000, 30],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors.join(' ')).toMatch(/Kommun: Folkbokföringskommun/)
  })

  it('fails a row with the dialog\'s own message when the tax table is missing', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön'],
      ['Test', 'Personson', PNR_A, '2026-01-01', 30000],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors.join(' ')).toMatch(/Skattetabell krävs/)
  })

  it('resolves the tax table from the kommun when the route supplies the map', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Kommun'],
      ['Test', 'Personson', PNR_A, '2026-01-01', 30000, 'Umeå kommun'],
      ['Okänd', 'Ort', PNR_B, '2026-01-01', 30000, 'Atlantis'],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, {
      now: NOW,
      kommunTableByName: { 'umeå': 34 },
    })
    expect(result.rows[0].employee.tax_table_number).toBe(34)
    expect(result.rows[0].employee.tax_municipality).toBe('Umeå kommun')
    expect(result.rows[0].is_valid).toBe(true)
    expect(result.rows[1].is_valid).toBe(false)
    expect(result.notices).toContainEqual({ code: 'employees_kommun_unmapped', severity: 'notice', params: { count: 1 } })
  })

  it('carries a cutover block when ingående columns have values', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Skattetabell', 'Kommun', 'Ingående bruttolön', 'Ingående skatt', 'Kvarvarande semesterdagar', 'Brytdatum'],
      ['Test', 'Personson', PNR_A, '2025-03-01', 30000, 30, 'Umeå', '240 000', '60 000', 12, '2026-09-01'],
      ['Utan', 'Saldon', PNR_B, '2026-09-01', 30000, 30, 'Umeå', '', '', '', ''],
      ['Fel', 'Datum', PNR_C, '2025-03-01', 30000, 30, 'Umeå', 1000, 0, 0, '2026-09-15'],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows[0].opening_balances).toEqual({
      cutover_date: '2026-09-01',
      ytd_gross: 240000,
      ytd_tax: 60000,
      ytd_net: 0,
      vacation_paid_days_remaining: 12,
    })
    expect(result.rows[0].is_valid).toBe(true)
    expect(result.rows[1].opening_balances).toBeNull()
    expect(result.rows[2].is_valid).toBe(false)
    expect(result.rows[2].validation_errors.join(' ')).toMatch(/första dagen/)
    expect(result.notices).toContainEqual({
      code: 'employees_opening_balances_detected', severity: 'info', params: { count: 2 },
    })
  })

  it('uses the default cutover date when the file has saldon but no brytdatum', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Skattetabell', 'Kommun', 'Ingående bruttolön'],
      ['Test', 'Personson', PNR_A, '2025-03-01', 30000, 30, 'Umeå', 1000],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW, defaultCutoverDate: '2026-09-01' })
    expect(result.rows[0].opening_balances?.cutover_date).toBe('2026-09-01')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('reads a semicolon CSV with Swedish decimals and a percent degree', () => {
    const csv =
      'Förnamn;Efternamn;Personnummer;Anställningsdatum;Månadslön;Skattetabell;Kommun;Sysselsättningsgrad\n' +
      `Test;Personson;${PNR_A};2026-01-01;32 500,00;30;Umeå;80 %\n`
    const result = parseEmployeesFile(buildCsv(csv), 'anstallda.csv', undefined, { now: NOW })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].employee.monthly_salary).toBe(32500)
    expect(result.rows[0].employee.employment_degree).toBe(80)
    expect(result.rows[0].is_valid, result.rows[0].validation_errors.join('; ')).toBe(true)
  })

  it('skips blank rows and flags a missing personnummer column', () => {
    const buffer = buildXlsx([
      ['Förnamn', 'Efternamn', 'Månadslön'],
      ['Test', 'Personson', 30000],
      ['', '', ''],
    ])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Personnummer saknas')
    expect(result.notices).toContainEqual({ code: 'employees_no_personnummer_column', severity: 'action' })
  })

  it('returns an action notice for a header-only file', () => {
    const buffer = buildXlsx([['Förnamn', 'Efternamn', 'Personnummer']])
    const result = parseEmployeesFile(buffer, 'x.xlsx', undefined, { now: NOW })
    expect(result.rows).toHaveLength(0)
    expect(result.notices).toContainEqual({ code: 'employees_too_few_rows', severity: 'action' })
  })
})
