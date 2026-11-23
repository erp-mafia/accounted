import { describe, expect, it } from 'vitest'
import { bankReconciliationSkill } from '../workflows/bank-reconciliation'

// run_currency_revaluation revalues open customer and supplier invoices
// (lib/bookkeeping/currency-revaluation.ts: 1510/2440 against 3960/7960). The
// skill said it revalues "FX accounts" and that a mismatch on a foreign bank
// account disappears after it, so an agent left a real difference alone. A
// foreign bank account is compared in its own currency: no rate is involved.
describe('bank-reconciliation skill: what the currency revaluation covers', () => {
  const body = bankReconciliationSkill.body
  const mentions = body.split('\n').filter((line) => line.includes('gnubok_run_currency_revaluation'))

  it('says at every mention that it is about invoices, not bank accounts', () => {
    expect(mentions.length).toBeGreaterThan(0)
    for (const line of mentions) {
      expect(line).toMatch(/customer and supplier invoices/)
      expect(line).toMatch(/not bank accounts|not revalue a bank account/)
    }
  })

  it('never tells an agent to leave a difference on a foreign account for a revaluation to clear', () => {
    expect(body).not.toMatch(/phantom mismatch/i)
    // The two claims themselves, not the words: "FX accounts" may be said of
    // something that is true.
    expect(body).not.toMatch(/FX accounts[^.\n]*(need|must be) revalu/i)
    expect(body).not.toMatch(/\(FX accounts only\)/)
  })
})
