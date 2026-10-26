/**
 * The bank whose upload instructions the salary payment file panel opens
 * first when the company has not picked one (company_settings
 * .salary_default_bank null): the bank of the company's own account, the one
 * that pays the salaries.
 *
 * A Swedish IBAN carries the bank's three-digit code right after the check
 * digits, the start of its clearing series, so the clearing table the payment
 * file already trusts for the debtor BIC names the bank. No IBAN, a foreign
 * IBAN or a bank outside the four with instructions answers null.
 *
 * Kept free of server imports: the panel is a client component.
 */

import { lookupBicByClearing } from '@/lib/payments/bank-account'

export type SalaryInstructionBank = 'swedbank' | 'seb' | 'handelsbanken' | 'nordea'

const BANK_BY_BIC: Readonly<Record<string, SalaryInstructionBank>> = {
  SWEDSESS: 'swedbank',
  ESSESESS: 'seb',
  HANDSESS: 'handelsbanken',
  NDEASESS: 'nordea',
}

/** The instruction bank a company IBAN names, or null when it names none of the four. */
export function salaryInstructionBankFromIban(iban: string | null | undefined): SalaryInstructionBank | null {
  const normalized = (iban ?? '').replace(/\s/g, '').toUpperCase()
  if (!/^SE\d{22}$/.test(normalized)) return null
  const bic = lookupBicByClearing(`${normalized.slice(4, 7)}0`)
  return bic ? (BANK_BY_BIC[bic] ?? null) : null
}
