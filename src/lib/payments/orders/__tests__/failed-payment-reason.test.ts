import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { failedPaymentReasonText, type BankPaymentsTranslator } from '../failed-payment-reason'

function bankPayments(messages: Record<string, unknown>, locale: string): BankPaymentsTranslator {
  return createTranslator({ locale, messages, namespace: 'bank_payments' }) as unknown as BankPaymentsTranslator
}

describe('failedPaymentReasonText', () => {
  const t = bankPayments(sv, 'sv')

  it('says the bank reason in words when Betalningar knows the code', () => {
    expect(failedPaymentReasonText(t, 'rejected', 'PSU_RIGHTS_MISSING')).toBe(sv.bank_payments.provider_PSU_RIGHTS_MISSING)
  })

  it('says what happened, with the code when the bank gave one Betalningar does not know', () => {
    expect(failedPaymentReasonText(t, 'rejected', 'RAW')).toBe('Banken avvisade betalningen. Bankens kod: RAW.')
    expect(failedPaymentReasonText(t, 'failed', null)).toBe('Banken tog inte emot betalningen.')
  })

  it('speaks English to an English screen', () => {
    expect(failedPaymentReasonText(bankPayments(en, 'en'), 'rejected', 'RAW')).toBe("The bank rejected the payment. The bank's code: RAW.")
  })
})
