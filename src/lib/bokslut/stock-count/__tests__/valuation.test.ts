import { describe, expect, it } from 'vitest'
import {
  categoryTotals,
  parseStockPaste,
  stockAdjustmentLines,
  stockAdjustments,
  stockRowValue,
} from '../valuation'

describe('stockRowValue', () => {
  it('values quantity x unit cost less the write-down, in öre', () => {
    expect(stockRowValue({ quantity: 120, unit_cost: 42.5, write_down_percent: 0 })).toBe(5100)
    expect(stockRowValue({ quantity: 3, unit_cost: 10.01, write_down_percent: 0 })).toBe(30.03)
    expect(stockRowValue({ quantity: 7, unit_cost: 13.33, write_down_percent: 3 })).toBe(90.51)
    expect(stockRowValue({ quantity: 2.5, unit_cost: 99.99, write_down_percent: 100 })).toBe(0)
  })

  it('clamps an out-of-range write-down', () => {
    expect(stockRowValue({ quantity: 1, unit_cost: 100, write_down_percent: 150 })).toBe(0)
    expect(stockRowValue({ quantity: 1, unit_cost: 100, write_down_percent: -5 })).toBe(100)
  })
})

describe('categoryTotals', () => {
  it('adds rounded row values per kind, cost and write-down beside them', () => {
    const totals = categoryTotals([
      { category: 'goods_for_resale', quantity: 10, unit_cost: 100, write_down_percent: 10 },
      { category: 'goods_for_resale', quantity: 1, unit_cost: 0.335, write_down_percent: 0 },
      { category: 'raw_materials', quantity: 4, unit_cost: 25, write_down_percent: 0 },
    ])
    expect(totals).toEqual([
      { category: 'raw_materials', cost: 100, write_down: 0, value: 100, rows: 1 },
      { category: 'goods_for_resale', cost: 1000.34, write_down: 100, value: 900.34, rows: 2 },
    ])
  })
})

describe('stockAdjustments and their lines', () => {
  const totals = categoryTotals([
    { category: 'goods_for_resale', quantity: 10, unit_cost: 100, write_down_percent: 0 },
    { category: 'raw_materials', quantity: 1, unit_cost: 500, write_down_percent: 0 },
  ])

  it('raises the stock when the count exceeds the ledger, lowers it otherwise', () => {
    const adjustments = stockAdjustments(totals, { '1460': 800, '1469': -50, '1410': 700 })
    expect(adjustments).toEqual([
      { category: 'raw_materials', stock_account: '1410', change_account: '4910', counted: 500, ledger: 700, adjustment: -200 },
      { category: 'goods_for_resale', stock_account: '1460', change_account: '4960', counted: 1000, ledger: 750, adjustment: 250 },
    ])
    const lines = stockAdjustmentLines(adjustments)
    expect(lines).toEqual([
      expect.objectContaining({ account_number: '4910', debit_amount: 200, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1410', debit_amount: 0, credit_amount: 200 }),
      expect.objectContaining({ account_number: '1460', debit_amount: 250, credit_amount: 0 }),
      expect.objectContaining({ account_number: '4960', debit_amount: 0, credit_amount: 250 }),
    ])
    const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(debit).toBe(credit)
    for (const line of lines) expect(typeof line.account_number).toBe('string')
  })

  it('writes a kind the ledger holds but the list lacks down to zero', () => {
    const adjustments = stockAdjustments(totals, { '1460': 1000, '1450': 300 })
    expect(adjustments.find((a) => a.category === 'finished_goods')).toMatchObject({ counted: 0, ledger: 300, adjustment: -300 })
  })

  it('books nothing when the ledger already holds the counted value', () => {
    const adjustments = stockAdjustments(totals, { '1460': 1000, '1410': 500 })
    expect(adjustments.every((a) => a.adjustment === 0)).toBe(true)
    expect(stockAdjustmentLines(adjustments)).toEqual([])
  })
})

describe('parseStockPaste', () => {
  it('reads tab, semicolon and comma lists with Swedish decimals and skips a header', () => {
    const parsed = parseStockPaste(
      ['Benämning\tAntal\tÀ-pris', 'Kaffe 500 g\t120\t42,50', 'Te; 10; 1 234,5; 3; st; råvaror', 'Socker,5,12.25'].join('\n'),
    )
    expect(parsed.rejected).toEqual([])
    expect(parsed.rows).toEqual([
      { description: 'Kaffe 500 g', unit: null, quantity: 120, unit_cost: 42.5, write_down_percent: 0, category: 'goods_for_resale' },
      { description: 'Te', unit: 'st', quantity: 10, unit_cost: 1234.5, write_down_percent: 3, category: 'raw_materials' },
      { description: 'Socker', unit: null, quantity: 5, unit_cost: 12.25, write_down_percent: 0, category: 'goods_for_resale' },
    ])
  })

  it('names the lines it could not read', () => {
    const parsed = parseStockPaste('Kaffe;12;40\n;3;4\nTe;x;5\nSalt;1;2;150')
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rejected).toEqual([2, 3, 4])
  })
})
