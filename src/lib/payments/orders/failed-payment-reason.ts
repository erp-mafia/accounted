/**
 * Why a bank payment did not go through, in words: the bank's reason as
 * Betalningar shows it (bank_payments.provider_<code>), else what happened
 * and the bank's code. One rule for the Att göra row (useTranslations) and
 * the mail (createTranslator in Swedish). Dependency-free, so client
 * components can import it.
 */

/** A translator scoped to the bank_payments namespace. */
export interface BankPaymentsTranslator {
  (key: string, values?: Record<string, string>): string
  has(key: string): boolean
}

export function failedPaymentReasonText(t: BankPaymentsTranslator, status: 'rejected' | 'failed', code: string | null): string {
  if (code && t.has(`provider_${code}`)) return t(`provider_${code}`)
  const plain = t(status === 'rejected' ? 'failed_reason_rejected' : 'failed_reason_failed')
  return code ? t('failed_reason_code', { reason: plain, code }) : plain
}
