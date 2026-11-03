import { describe, expect, it } from 'vitest'
import { buildInvoiceBasisCsv, resolveHourlyRate, summarizeByCustomerMonth, summarizeTimeByMonth } from '../summary'

const settings = {
  activity_codes: [
    { code: '1', name: 'Löpande', hourly_rate: 950 },
    { code: '2', name: 'Bokslut', hourly_rate: null },
  ],
  default_hourly_rate: 800,
}

const base = {
  customer_id: null,
  customer_code: 'GF',
  customer_name: 'Galärbryggan',
  activity_code: '1',
  is_billable: true,
  invoice_id: null,
}

describe('resolveHourlyRate', () => {
  it('prefers the activity code rate, then the default', () => {
    expect(resolveHourlyRate('1', settings)).toBe(950)
    expect(resolveHourlyRate('2', settings)).toBe(800)
    expect(resolveHourlyRate(null, settings)).toBe(800)
    expect(resolveHourlyRate('1', { activity_codes: [], default_hourly_rate: null })).toBeNull()
  })
})

describe('summarizeByCustomerMonth', () => {
  it('groups per customer and month and prices only uninvoiced billable hours', () => {
    const result = summarizeByCustomerMonth(
      [
        { ...base, entry_date: '2026-06-15', hours: 7.5 },
        { ...base, entry_date: '2026-06-16', hours: 0.1 },
        { ...base, entry_date: '2026-06-17', hours: 0.2 },
        { ...base, entry_date: '2026-06-20', hours: 2, invoice_id: 'inv-1' },
        { ...base, entry_date: '2026-06-21', hours: 1, is_billable: false },
        { ...base, entry_date: '2026-07-01', hours: 2.25, activity_code: '2' },
      ],
      settings,
    )

    expect(result).toEqual([
      expect.objectContaining({ month: '2026-07', hours: 2.25, uninvoiced_billable_hours: 2.25, uninvoiced_amount: 1800 }),
      expect.objectContaining({
        month: '2026-06',
        hours: 10.8,
        billable_hours: 9.8,
        uninvoiced_billable_hours: 7.8,
        uninvoiced_amount: 7410,
      }),
    ])
  })

  it('reports a missing rate as null instead of a partial amount', () => {
    const [row] = summarizeByCustomerMonth([{ ...base, entry_date: '2026-06-15', hours: 1 }], {
      activity_codes: [],
      default_hourly_rate: null,
    })
    expect(row.uninvoiced_amount).toBeNull()
  })
})

describe('buildInvoiceBasisCsv', () => {
  it('writes semicolon CSV with decimal commas and neutralises formulas', () => {
    const csv = buildInvoiceBasisCsv(
      [
        {
          ...base,
          entry_date: '2026-06-15',
          hours: 1.5,
          consultant: 'GK',
          project_code: null,
          comment: '=HYPERLINK("x"); moms',
        },
      ],
      settings,
    )
    const [header, line] = csv.replace('﻿', '').trim().split('\r\n')
    expect(header).toBe('Datum;Kund;Kundnamn;Projekt;Medarbetare;A-kod;Timmar;Timpris;Belopp;Kommentar')
    expect(line).toBe('2026-06-15;GF;Galärbryggan;;GK;1;1,5;950;1425;"\'=HYPERLINK(""x""); moms"')
  })
})

describe('summarizeTimeByMonth', () => {
  const entry = { ...base, consultant: 'AB', project_code: 'P1' as string | null }

  it('groups by project, with hours without a project in one unlabelled group', () => {
    const rows = summarizeTimeByMonth(
      [
        { ...entry, entry_date: '2026-06-01', hours: 2 },
        { ...entry, entry_date: '2026-06-02', hours: 1, project_code: null },
        { ...entry, entry_date: '2026-06-03', hours: 0.5, project_code: null },
      ],
      settings,
      'project',
    )
    expect(rows).toEqual([
      expect.objectContaining({ key: '', label: null, month: '2026-06', hours: 1.5 }),
      expect.objectContaining({ key: 'P1', label: 'P1', month: '2026-06', hours: 2, uninvoiced_amount: 1900 }),
    ])
  })

  it('groups by consultant and month, newest month first', () => {
    const rows = summarizeTimeByMonth(
      [
        { ...entry, entry_date: '2026-06-01', hours: 2 },
        { ...entry, entry_date: '2026-07-01', hours: 1, consultant: 'CD' },
      ],
      settings,
      'consultant',
    )
    expect(rows.map((r) => [r.month, r.key])).toEqual([['2026-07', 'CD'], ['2026-06', 'AB']])
  })

  it('labels a customer group by its name, else its code', () => {
    const rows = summarizeTimeByMonth(
      [{ ...entry, entry_date: '2026-06-01', hours: 1, customer_name: null }],
      settings,
      'customer',
    )
    expect(rows[0]).toMatchObject({ key: 'code:GF', label: 'GF' })
  })
})
