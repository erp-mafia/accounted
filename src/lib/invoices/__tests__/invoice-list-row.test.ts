import { describe, expect, it } from 'vitest'
import { withDeductionFacts, type InvoiceDeductionFacts } from '../invoice-list-row'
import { rotRutListStateOf } from '../rot-rut-list-status'

describe('withDeductionFacts', () => {
  const rows = [
    { id: 'a', status: 'paid', deduction_total: 5000 },
    { id: 'b', status: 'paid', deduction_total: 0 },
  ]

  it('joins the begäran and the deduction kinds onto the invoice they belong to', () => {
    const facts = new Map<string, InvoiceDeductionFacts>([
      [
        'a',
        {
          rot_rut_items: [{ request: { id: 'r1', status: 'submitted', created_at: '2026-10-01T00:00:00Z' } }],
          deduction_lines: [{ deduction_type: 'rot' }],
        },
      ],
    ])
    const joined = withDeductionFacts(rows, facts)
    expect(joined[0].rot_rut_items).toHaveLength(1)
    expect(joined[0].deduction_lines).toEqual([{ deduction_type: 'rot' }])
    // The list's own state rule reads the joined row as it read the embedded one.
    expect(rotRutListStateOf(joined[0])).toBe('submitted')
    expect(joined[1]).toBe(rows[1])
    expect(rotRutListStateOf(joined[1])).toBeNull()
  })

  it('keeps a paid deduction invoice with no begäran claimable', () => {
    const facts = new Map<string, InvoiceDeductionFacts>([
      ['a', { rot_rut_items: [], deduction_lines: [{ deduction_type: 'rut' }] }],
    ])
    expect(rotRutListStateOf(withDeductionFacts(rows, facts)[0])).toBe('claimable')
  })

  it('returns the rows untouched when no invoice has a deduction', () => {
    expect(withDeductionFacts(rows, new Map())).toBe(rows)
  })
})
