/**
 * Every arbetsgivardeklaration against the salaries and the official tax
 * tables, then the year's declarations against the personnel costs in the
 * ledger: payroll and the books must tell one story.
 */
import { describe, expect, it } from 'vitest'
import { loadSimCompany } from './company'
import type { PayrollMonth } from './answer-key'

const { state, plan, key, supabase, doors } = loadSimCompany()

interface Declaration {
  period_year: number
  period_month: number
  xml_content: string
  individuppgifter: Array<Record<string, unknown>>
  total_gross: number
  total_tax: number
  total_avgifter: number
  employee_count: number
}

async function declaration(month: PayrollMonth): Promise<Declaration> {
  const { data, error } = await supabase
    .from('agi_declarations')
    .select('period_year, period_month, xml_content, individuppgifter, total_gross, total_tax, total_avgifter, employee_count')
    .eq('company_id', state.companyId)
    .eq('period_year', month.year)
    .eq('period_month', month.month)
    .single()
  if (error) throw new Error(`no AGI for ${month.year}-${month.month}: ${error.message}`)
  return data as unknown as Declaration
}

const field = (xml: string, code: string) =>
  [...xml.matchAll(new RegExp(`faltkod="${code}">([^<]*)<`, 'g'))].map((match) => Number(match[1]))
const ascending = (values: number[]) => [...values].sort((a, b) => a - b)

const months = Object.entries(key.payroll).map(([label, month]) => ({ label, month }))

describe.each(months)('arbetsgivardeklaration $label', ({ month }) => {
  it('declares the gross, the tax and the avgifter of the month', async () => {
    const row = await declaration(month)
    expect({
      gross: Number(row.total_gross),
      tax: Number(row.total_tax),
      avgifter: Number(row.total_avgifter),
      people: row.employee_count,
    }).toEqual({
      gross: month.totalGross,
      tax: month.totalTax,
      avgifter: month.filedAvgifter,
      people: month.employees.length,
    })
  })

  it('files the same figures in the XML, per person and in total', async () => {
    const { xml_content: xml } = await declaration(month)
    expect(field(xml, '487')).toEqual([month.filedAvgifter])
    expect(field(xml, '497')).toEqual([month.totalTax])
    expect(ascending(field(xml, '011'))).toEqual(ascending(month.employees.map((row) => row.gross)))
    expect(ascending(field(xml, '001'))).toEqual(ascending(month.employees.map((row) => row.tax)))
  })
})

describe.each(plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : [])))('payroll of %i', (year) => {
  it('is the personnel cost the year-end accounts carry', async () => {
    const declared = Object.values(key.payroll).filter((month) => month.year === year)
    const { rows } = await doors.call('gnubok_get_trial_balance', { period_id: state.fiscalPeriods[year] })
    // Debits alone: the year's closing entry credits every cost account back to zero.
    const booked = (accounts: string[]) =>
      rows
        .filter((row: { account_number: string }) => accounts.includes(row.account_number))
        .reduce((total: number, row: { period_debit: number }) => total + row.period_debit, 0)
    expect(booked(['7210', '7220'])).toBeCloseTo(declared.reduce((total, month) => total + month.totalGross, 0), 2)
    expect(booked(['7510'])).toBeCloseTo(declared.reduce((total, month) => total + month.totalAvgifter, 0), 2)
  })
})
