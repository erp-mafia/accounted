import { describe, expect, it } from 'vitest'
import {
  PAYSLIP_LINE_BAND,
  TEXT_ROW_AMOUNT_MESSAGE,
  TEXT_ROW_BLANK_MESSAGE,
  TEXT_ROW_MAX_LENGTH,
  TEXT_ROW_QUANTITY_MESSAGE,
  TEXT_ROW_TOO_LONG_MESSAGE,
  ZERO_AMOUNT_MESSAGE,
  comparePayslipLines,
  isTextRow,
  normalizeTextRow,
  payslipLineBand,
  validatePayslipLineContent,
  validateTextRow,
} from '@/lib/salary/text-rows'
import { SalaryLineItemTypeSchema } from '@/lib/api/schemas'

describe('normalizeTextRow', () => {
  it('trims and collapses every line break (with the spaces around it) to one space', () => {
    expect(normalizeTextRow('  Grundlön enligt avtal \r\n  Tillägg ingår\n\nI lönen  ')).toBe(
      'Grundlön enligt avtal Tillägg ingår I lönen',
    )
  })

  it('leaves single-line text with inner spaces alone', () => {
    expect(normalizeTextRow('Lön  enligt kollektivavtal')).toBe('Lön  enligt kollektivavtal')
  })
})

describe('validateTextRow (mirrors salary_line_items_text_row)', () => {
  it('accepts words with no amount, or amount 0', () => {
    expect(validateTextRow({ description: 'Lönen består av grundlön och tillägg' })).toBeNull()
    expect(validateTextRow({ description: 'Text', amount: 0 })).toBeNull()
    expect(validateTextRow({ description: 'Text', amount: null, quantity: null, unit_price: null })).toBeNull()
  })

  it('refuses blank text, including only line breaks', () => {
    for (const description of ['', '   ', '\n\r\n', null, undefined]) {
      expect(validateTextRow({ description })).toEqual({ field: 'description', message: TEXT_ROW_BLANK_MESSAGE })
    }
  })

  it('caps the normalised text at TEXT_ROW_MAX_LENGTH characters', () => {
    expect(validateTextRow({ description: 'x'.repeat(TEXT_ROW_MAX_LENGTH) })).toBeNull()
    expect(validateTextRow({ description: 'x'.repeat(TEXT_ROW_MAX_LENGTH + 1) })).toEqual({
      field: 'description',
      message: TEXT_ROW_TOO_LONG_MESSAGE,
    })
  })

  it('refuses an amount, a quantity or an à-pris', () => {
    expect(validateTextRow({ description: 'Text', amount: 500 })).toEqual({ field: 'amount', message: TEXT_ROW_AMOUNT_MESSAGE })
    expect(validateTextRow({ description: 'Text', amount: -1 })).toEqual({ field: 'amount', message: TEXT_ROW_AMOUNT_MESSAGE })
    expect(validateTextRow({ description: 'Text', quantity: 1 })).toEqual({ field: 'quantity', message: TEXT_ROW_QUANTITY_MESSAGE })
    expect(validateTextRow({ description: 'Text', unit_price: 1 })).toEqual({ field: 'unit_price', message: TEXT_ROW_QUANTITY_MESSAGE })
  })
})

describe('validatePayslipLineContent (every door)', () => {
  it('a text row carries words and no amount', () => {
    expect(validatePayslipLineContent({ item_type: 'text', description: 'Lönen enligt avtal' })).toBeNull()
    expect(validatePayslipLineContent({ item_type: 'text', description: 'Text', amount: 100 })?.field).toBe('amount')
  })

  it('refuses a 0 kr or missing amount on a money row (crm#1076: it printed "0,00")', () => {
    for (const amount of [0, undefined, null, Number.NaN]) {
      expect(validatePayslipLineContent({ item_type: 'other', description: 'Semesterdagar kvar: 12', amount })).toEqual({
        field: 'amount',
        message: ZERO_AMOUNT_MESSAGE,
      })
    }
    expect(validatePayslipLineContent({ item_type: 'bonus', description: 'Bonus', amount: 1 })).toBeNull()
    expect(validatePayslipLineContent({ item_type: 'net_deduction_other', description: 'Avdrag', amount: -1 })).toBeNull()
  })

  it('accepts a vacation row that carries days and no amount, but not one with neither', () => {
    expect(validatePayslipLineContent({ item_type: 'vacation', description: 'Semester', amount: 0, quantity: 3 })).toBeNull()
    expect(validatePayslipLineContent({ item_type: 'vacation', description: 'Semester', amount: 0 })?.field).toBe('amount')
  })
})

describe('payslip order', () => {
  const row = (item_type: string, sort_order: number, source_recurring_line_id: string | null = null) => ({
    item_type,
    sort_order,
    source_recurring_line_id,
    description: `${item_type}-${sort_order}`,
  })

  it('base salary, recurring text, manual text, then the rest by sort_order', () => {
    const lines = [
      row('oresavrundning', 900),
      row('text', 0),
      row('net_deduction_union', 250, 'r1'),
      row('bonus', 0),
      row('text', 10, 'r2'),
      row('sick_karens', 100),
      row('monthly_salary', 0),
      row('semesterersattning', 50),
    ]
    expect([...lines].sort(comparePayslipLines).map((l) => l.description)).toEqual([
      'monthly_salary-0',
      'text-10',
      'text-0',
      'bonus-0',
      'semesterersattning-50',
      'sick_karens-100',
      'net_deduction_union-250',
      'oresavrundning-900',
    ])
  })

  it('bands', () => {
    expect(payslipLineBand(row('hourly_salary', 0))).toBe(PAYSLIP_LINE_BAND.baseSalary)
    expect(payslipLineBand(row('text', 10, 'r'))).toBe(PAYSLIP_LINE_BAND.recurringText)
    expect(payslipLineBand(row('text', 0))).toBe(PAYSLIP_LINE_BAND.manualText)
    expect(payslipLineBand(row('other', 0))).toBe(PAYSLIP_LINE_BAND.other)
  })

  it('keeps the read order of rows that tie', () => {
    const lines = [row('bonus', 0), { ...row('other', 0), description: 'second' }]
    expect([...lines].sort(comparePayslipLines).map((l) => l.description)).toEqual(['bonus-0', 'second'])
  })
})

describe('the type', () => {
  it('is a line type the schema accepts', () => {
    expect(SalaryLineItemTypeSchema.safeParse('text').success).toBe(true)
    expect(isTextRow({ item_type: 'text' })).toBe(true)
    expect(isTextRow({ item_type: 'other' })).toBe(false)
  })
})
