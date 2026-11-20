import { describe, it, expect } from 'vitest'
import { rosterRowsWithoutCalculation, runCalculationState } from '../calculation-state'

const PARAMS = { configYear: 2026, avgifterTotal: 0.3142 }
const BREAKDOWN = { steps: [{ label: 'Bruttolön', formula: '45556', output: 45556 }] }

describe('runCalculationState', () => {
  it('is not_calculated before the first calculation froze its snapshot', () => {
    expect(runCalculationState({ status: 'draft', calculation_params: null }, [])).toBe('not_calculated')
    expect(
      runCalculationState({ status: 'draft', calculation_params: null }, [{ calculation_breakdown: null }]),
    ).toBe('not_calculated')
  })

  it('is current when every roster row carries a breakdown', () => {
    const roster = [{ calculation_breakdown: BREAKDOWN }, { calculation_breakdown: BREAKDOWN }]
    expect(runCalculationState({ status: 'draft', calculation_params: PARAMS }, roster)).toBe('current')
    expect(runCalculationState({ status: 'review', calculation_params: PARAMS }, roster)).toBe('current')
  })

  it('is current for a calculated empty roster (a nolldeklaration)', () => {
    expect(runCalculationState({ status: 'draft', calculation_params: PARAMS }, [])).toBe('current')
  })

  it('is stale after a payment date change cleared the breakdowns but kept the snapshot (crm#1001)', () => {
    // The shape the PATCH leaves: figures and calculation_params stay, every
    // row's breakdown is gone. The page used to call this calculated.
    const roster = [{ calculation_breakdown: null }]
    expect(runCalculationState({ status: 'draft', calculation_params: PARAMS }, roster)).toBe('stale')
  })

  it('is stale when one employee was added or edited after the calculation', () => {
    const roster = [{ calculation_breakdown: BREAKDOWN }, { calculation_breakdown: null }]
    expect(runCalculationState({ status: 'draft', calculation_params: PARAMS }, roster)).toBe('stale')
  })

  it('is stale for a run that reached review with a cleared breakdown', () => {
    const roster = [{ calculation_breakdown: null }]
    expect(runCalculationState({ status: 'review', calculation_params: PARAMS }, roster)).toBe('stale')
  })

  it('treats a missing breakdown key like a cleared one', () => {
    expect(runCalculationState({ status: 'draft', calculation_params: PARAMS }, [{}])).toBe('stale')
  })

  it('never calls an approved, paid or booked run stale: its figures are frozen', () => {
    const roster = [{ calculation_breakdown: null }]
    for (const status of ['approved', 'paid', 'booked', 'corrected']) {
      expect(runCalculationState({ status, calculation_params: PARAMS }, roster)).toBe('current')
    }
  })
})

describe('rosterRowsWithoutCalculation', () => {
  it('returns exactly the rows without a breakdown, keeping their other fields', () => {
    const rows = [
      { id: 'a', calculation_breakdown: BREAKDOWN },
      { id: 'b', calculation_breakdown: null },
      { id: 'c' },
    ]
    expect(rosterRowsWithoutCalculation(rows).map((row) => row.id)).toEqual(['b', 'c'])
  })
})
