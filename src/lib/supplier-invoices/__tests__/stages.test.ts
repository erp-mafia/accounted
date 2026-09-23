import { describe, it, expect } from 'vitest'
import { countByStage, deriveStage, stageIndex, stagesFor, SUPPLIER_INVOICE_STAGES } from '../stages'

const base = { status: 'registered', approved_at: null, is_credit_note: false, in_open_batch: false, reconciled: false }

describe('supplier invoice stages', () => {
  it('walks the ladder from registered to reconciled', () => {
    expect(deriveStage(base)).toBe('registered')
    expect(deriveStage({ ...base, status: 'overdue' })).toBe('registered')
    expect(deriveStage({ ...base, approved_at: '2026-09-06T10:00:00Z' })).toBe('approved')
    expect(deriveStage({ ...base, status: 'approved' })).toBe('approved')
    expect(deriveStage({ ...base, approved_at: '2026-09-06T10:00:00Z', in_open_batch: true })).toBe('in_file')
    expect(deriveStage({ ...base, status: 'paid', approved_at: '2026-09-06T10:00:00Z' })).toBe('paid')
    expect(deriveStage({ ...base, status: 'paid', reconciled: true })).toBe('reconciled')
  })

  it('takes credit notes and credited invoices off the ladder', () => {
    expect(deriveStage({ ...base, is_credit_note: true })).toBe('credited')
    expect(deriveStage({ ...base, status: 'credited' })).toBe('credited')
    expect(deriveStage({ ...base, status: 'reversed', approved_at: 'x' })).toBe('credited')
    expect(stageIndex('credited')).toBe(-1)
  })

  it('a paid invoice still in an old batch reads as paid, not in file', () => {
    expect(deriveStage({ ...base, status: 'paid', in_open_batch: true })).toBe('paid')
  })

  it('kontantmetod companies skip the attest step', () => {
    expect(stagesFor('cash')).toEqual(['incoming', 'registered', 'in_file', 'paid', 'reconciled'])
    expect(stagesFor('accrual')).toEqual([...SUPPLIER_INVOICE_STAGES])
    expect(stagesFor(null)).toEqual([...SUPPLIER_INVOICE_STAGES])
  })

  it('counts invoices per stage', () => {
    const counts = countByStage([
      { stage: 'registered', approved_at: null, batch: null, paid: null, reconciled_through: null },
      { stage: 'registered', approved_at: null, batch: null, paid: null, reconciled_through: null },
      { stage: 'paid', approved_at: null, batch: null, paid: null, reconciled_through: null },
    ])
    expect(counts.registered).toBe(2)
    expect(counts.paid).toBe(1)
    expect(counts.reconciled).toBe(0)
  })
})
