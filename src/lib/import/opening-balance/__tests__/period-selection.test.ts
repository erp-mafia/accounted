import { describe, it, expect } from 'vitest'
import {
  pickDefaultOpeningBalancePeriod,
  type SelectableFiscalPeriod,
} from '../period-selection'

const period = (
  id: string,
  overrides: Partial<SelectableFiscalPeriod> = {},
): SelectableFiscalPeriod => ({
  id,
  is_closed: false,
  locked_at: null,
  opening_balances_set: false,
  ...overrides,
})

describe('pickDefaultOpeningBalancePeriod', () => {
  it('picks the open period that has no opening balance yet', () => {
    const fresh = period('fresh')
    expect(pickDefaultOpeningBalancePeriod([fresh])?.id).toBe('fresh')
  })

  it('prefers a period without an opening balance over one that has it', () => {
    const withOB = period('with-ob', { opening_balances_set: true })
    const fresh = period('fresh')

    expect(pickDefaultOpeningBalancePeriod([withOB, fresh])?.id).toBe('fresh')
  })

  /**
   * The regression. A company with one fiscal year that already carries an IB
   * got nothing preselected, so the button stayed disabled and kept the label
   * of an action it could not perform. Replacing the IB is supported, and it
   * is reachable only once the period is selected.
   */
  it('picks the only open period even when it already has an opening balance', () => {
    const onlyOne = period('only', { opening_balances_set: true })

    expect(pickDefaultOpeningBalancePeriod([onlyOne])?.id).toBe('only')
  })

  it('never picks a closed or locked period', () => {
    const closed = period('closed', { is_closed: true })
    const locked = period('locked', { locked_at: '2026-03-01T00:00:00Z' })

    expect(pickDefaultOpeningBalancePeriod([closed, locked])).toBeUndefined()
  })

  it('skips a closed period to reach a writable one that has an opening balance', () => {
    const closed = period('closed', { is_closed: true })
    const open = period('open', { opening_balances_set: true })

    expect(pickDefaultOpeningBalancePeriod([closed, open])?.id).toBe('open')
  })

  it('returns undefined when there are no periods', () => {
    expect(pickDefaultOpeningBalancePeriod([])).toBeUndefined()
  })
})
