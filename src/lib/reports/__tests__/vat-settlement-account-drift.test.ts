import { describe, expect, it } from 'vitest'
import { settlementAccountDrift, type SettlementDayRow } from '../vat-settlement-account-drift'
import { settlementAccountDriftBlocker } from '../vat-close-check'

const credit = (account: string, date: string, amount: number): SettlementDayRow => ({ account_number: account, entry_date: date, debit: 0, credit: amount })
const debit = (account: string, date: string, amount: number): SettlementDayRow => ({ account_number: account, entry_date: date, debit: amount, credit: 0 })

describe('settlementAccountDrift', () => {
  it('reads a quarterly filer that books every charge as clean, and a period not yet charged as recent', () => {
    const rows = [
      credit('2650', '2026-03-31', 10000), // Q1 momsredovisning
      debit('2650', '2026-05-12', 10000), // Skatteverket's charge, booked
      credit('2650', '2026-06-30', 12000), // Q2, due 12 August
    ]
    // 26 October: Q2 lies 118 days back, inside the window even if not yet booked as charged.
    expect(settlementAccountDrift(rows, '2026-10-26', null)).toMatchObject({ payable_drift: 0, receivable_drift: 0 })
    // 1 December: Q2's charge was due long ago and is still not booked.
    expect(settlementAccountDrift(rows, '2026-12-01', null).payable_drift).toBe(12000)
  })

  it('adds up every period whose charge was never booked', () => {
    const rows = [credit('2650', '2025-03-31', 8000), credit('2650', '2025-06-30', 9000), credit('2650', '2025-09-30', 7000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable_drift).toBe(24000)
  })

  it('takes the balance oldest first: one payment for two periods clears both', () => {
    const rows = [credit('2650', '2025-12-31', 10000), credit('2650', '2026-03-31', 12000), debit('2650', '2026-05-12', 22000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable_drift).toBe(0)
  })

  it('never flags a company that dates the momsredovisning on the charge day or clears it at once', () => {
    const rows = [credit('2650', '2025-08-12', 15000), debit('2650', '2025-08-12', 15000)]
    expect(settlementAccountDrift(rows, '2026-10-26', null).payable_drift).toBe(0)
  })

  it('flags a refund that was never booked as paid out', () => {
    const rows = [debit('1650', '2025-12-31', 4300)]
    expect(settlementAccountDrift(rows, '2026-10-26', null)).toMatchObject({ payable_drift: 0, receivable_drift: 4300 })
  })

  it('reports what was already stale at the last imported verifikat apart, and only what built up since as drift', () => {
    const rows = [
      credit('2650', '2018-09-01', 50000), // opening balance in the old system, never cleared
      credit('2650', '2026-03-31', 10000), // after the move: Q1, never charged
    ]
    expect(settlementAccountDrift(rows, '2026-10-26', '2025-12-31')).toMatchObject({
      payable_drift: 10000,
      inherited_payable: 50000,
    })
    expect(settlementAccountDrift([rows[0]], '2026-10-26', '2025-12-31')).toMatchObject({ payable_drift: 0, inherited_payable: 50000 })
  })
})

describe('settlementAccountDriftBlocker', () => {
  it('stays quiet below 100 kr: öre rounding on 2650 is not a finding', () => {
    expect(settlementAccountDriftBlocker({ as_of: '2026-10-26', payable_drift: 99, receivable_drift: 0, inherited_payable: 0, inherited_receivable: 0 })).toBeNull()
  })

  it('names the amount, the account and the fix as a medium finding that does not stop the close', () => {
    const blocker = settlementAccountDriftBlocker({ as_of: '2026-10-26', payable_drift: 53775, receivable_drift: 0, inherited_payable: 0, inherited_receivable: 0 })
    expect(blocker).toMatchObject({ kind: 'earlier_vat_on_settlement_account', severity: 'medium', count: 1 })
    expect(blocker?.message).toMatch(/53\s775/)
    expect(blocker?.message).toContain('2650')
    expect(blocker?.hint).toContain('Skattekonto')
  })
})
