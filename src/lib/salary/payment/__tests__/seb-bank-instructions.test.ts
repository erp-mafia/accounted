import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { SALARY_PAYMENT_FILE_FORMATS } from '../payment-format'

// The per-bank upload instructions the salary payment file panel shows
// (components/salary/PaymentFilePanel.tsx, salary_payments.steps_<format>_<bank>).
const BANKS = ['swedbank', 'seb', 'handelsbanken', 'nordea'] as const
const LOCALES = { sv: sv.salary_payments, en: en.salary_payments } as Record<string, Record<string, string>>

describe('salary payment file bank instructions', () => {
  it.each(Object.keys(LOCALES))('has a step text for every format and bank in %s', (locale) => {
    for (const format of SALARY_PAYMENT_FILE_FORMATS) {
      for (const bank of BANKS) {
        expect(LOCALES[locale][`steps_${format}_${bank}`]?.trim(), `steps_${format}_${bank}`).toBeTruthy()
      }
    }
  })

  // crm#1391: SEB's internet bank takes only SEB's own CSV template on
  // upload. The SEB text sent customers without a file transfer agreement to
  // the Bankgirot LB file, which SEB refuses too, so they had no working path.
  describe('SEB', () => {
    it('never sends the customer to upload the LB file at SEB', () => {
      expect(sv.salary_payments.steps_pain001_seb).not.toMatch(/välj Bankgirot LB/i)
      expect(en.salary_payments.steps_pain001_seb).not.toMatch(/choose the Bankgirot LB/i)
      expect(sv.salary_payments.steps_bg_lb_seb).toMatch(/tar inte emot LB-filen/)
      expect(en.salary_payments.steps_bg_lb_seb).toMatch(/does not accept the LB file/)
    })

    it.each(['steps_bg_lb_seb', 'steps_pain001_seb'] as const)('%s names the path that works without an agreement', (key) => {
      expect(sv.salary_payments[key]).toMatch(/filkommunikationsavtal/)
      expect(sv.salary_payments[key]).toMatch(/banklistan/)
      expect(en.salary_payments[key]).toMatch(/file transfer agreement/)
      expect(en.salary_payments[key]).toMatch(/bank list/)
    })
  })
})
