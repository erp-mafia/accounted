import { describe, expect, it } from 'vitest'
import { reconcileMonthSkill } from '../workflows/reconcile-month'

// On a bank account the bridge compares movements inside the window: no
// opening balance, no ignored rows, and an unbooked row counts as explained
// because it is listed. unexplained_difference 0 therefore says nothing about
// the bank's own balance; bank.balance_check is the one comparison with it
// (lib/reconciliation/bank-balance-check.ts). The skill used to tell an agent
// to stop at unexplained_difference 0 without ever naming balance_check.
describe('reconcile-month skill: a bank account is judged on its balance too', () => {
  const body = reconcileMonthSkill.body

  it('says the bank bridge compares movements, not balances', () => {
    expect(body).toMatch(/On a bank account the bridge compares movements inside the window, not balances/)
  })

  it('never stops an account on unexplained_difference 0 alone', () => {
    const stop = body.split('\n').find((line) => line.includes('Stop working an account'))
    expect(stop).toBeDefined()
    expect(stop).toMatch(/bank\.balance_check/)
  })

  it('explains every part of balance_check, its date and its refusals', () => {
    for (const part of ['`unbooked`', '`before_history`', '`rest`', '`as_of`', 'NO_BANK_BALANCE', 'FOREIGN_CURRENCY_ACCOUNT', 'NO_FISCAL_PERIOD']) {
      expect(body, part).toContain(part)
    }
    expect(body).toMatch(/When `as_of` is after the month end, say so plainly/)
  })

  it('reads the bank balance on the sign-off date from the sign-off preview, and its warning never blocks', () => {
    const step4 = body.slice(body.indexOf('## Step 4: Sign off'), body.indexOf('## Report'))
    for (const field of ['`bank_balance`', '`booked_balance`', '`warning`', 'BANK_BALANCE_DIFFERS', 'NO_BANK_BALANCE']) {
      expect(step4, field).toContain(field)
    }
    expect(step4).toMatch(/The warning never blocks/)
  })
})
