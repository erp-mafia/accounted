/**
 * #PBUDGET in the SIE parser (accounted#134, part 2): the month's budget per
 * account and object, read apart from the bookkeeping. The ledger import
 * ignores the rows and says where they go; the budget import reads them.
 */
import { describe, it, expect } from 'vitest'
import { parseSIEFile } from '../sie-parser'

const HEAD = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Budget AB"',
  '#RAR 0 20270101 20271231',
  '#RAR -1 20260101 20261231',
  '#KONTO 3010 "Försäljning"',
  '#KONTO 5010 "Lokalhyra"',
  '#DIM 6 "Projekt"',
  '#OBJEKT 6 "H1" "Hem 1"',
]

describe('parseSIEFile: #PBUDGET', () => {
  it('reads the year index, the month, the account, the object list and the amount', () => {
    const parsed = parseSIEFile(
      [
        ...HEAD,
        '#PBUDGET 0 202701 3010 {} -100000.00',
        '#PBUDGET 0 202702 5010 {6 "H1"} 12500.50 3',
        '#PBUDGET -1 202612 3010 {} -90000',
      ].join('\n'),
    )
    expect(parsed.periodBudgets).toEqual([
      { yearIndex: 0, month: '2027-01', account: '3010', amount: -100000, line: 10 },
      { yearIndex: 0, month: '2027-02', account: '5010', dimensions: { '6': 'H1' }, amount: 12500.5, quantity: 3, line: 11 },
      { yearIndex: -1, month: '2026-12', account: '3010', amount: -90000, line: 12 },
    ])
  })

  it('keeps the budget out of the bookkeeping and tells the ledger import where it goes', () => {
    const parsed = parseSIEFile([...HEAD, '#PBUDGET 0 202701 3010 {} -100000.00'].join('\n'))
    expect(parsed.vouchers).toEqual([])
    expect(parsed.resultBalances).toEqual([])
    const notice = parsed.issues.find((i) => i.tag === 'PBUDGET')
    expect(notice).toMatchObject({ severity: 'info' })
    expect(notice!.message).toContain('1 budgetrader')
    expect(notice!.message).toContain('Budget')
    // No longer an unknown, silently skipped tag.
    expect(parsed.issues.some((i) => i.message.includes('Okänd tagg: #PBUDGET'))).toBe(false)
  })

  it('reads an amount whose writer left the object list out', () => {
    const parsed = parseSIEFile([...HEAD, '#PBUDGET 0 202703 3010 -5000'].join('\n'))
    expect(parsed.periodBudgets).toEqual([{ yearIndex: 0, month: '2027-03', account: '3010', amount: -5000, line: 10 }])
  })

  it('skips a malformed period or amount with a warning instead of reading it as zero', () => {
    const parsed = parseSIEFile(
      [...HEAD, '#PBUDGET 0 2027-01 3010 {} -1', '#PBUDGET 0 202713 3010 {} -1', '#PBUDGET 0 202701 3010 {} abc'].join('\n'),
    )
    expect(parsed.periodBudgets).toEqual([])
    const warnings = parsed.issues.filter((i) => i.tag === 'PBUDGET' && i.severity === 'warning')
    expect(warnings).toHaveLength(3)
  })

  it('still skips #PSALDO silently', () => {
    const parsed = parseSIEFile([...HEAD, '#PSALDO 0 202701 3010 {} -42000.00'].join('\n'))
    expect(parsed.periodBudgets).toEqual([])
    expect(parsed.issues.some((i) => i.message.includes('#PSALDO'))).toBe(false)
  })
})
