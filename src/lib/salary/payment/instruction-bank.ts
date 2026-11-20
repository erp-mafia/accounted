/**
 * The bank whose upload instructions the salary payment file panel opens
 * first: the bank of the account the file pays from (lib/payments/
 * paying-account.ts), since that is the bank the file is uploaded to.
 * company_settings.salary_default_bank, the company's own pick, is only the
 * fallback for an account whose bank has no instructions here (crm#1483: the
 * pick could name another bank than the one the file paid from).
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

const INSTRUCTION_BANKS: ReadonlySet<string> = new Set(Object.values(BANK_BY_BIC))

/** The instruction bank a company IBAN names, or null when it names none of the four. */
export function salaryInstructionBankFromIban(iban: string | null | undefined): SalaryInstructionBank | null {
  const normalized = (iban ?? '').replace(/\s/g, '').toUpperCase()
  if (!/^SE\d{22}$/.test(normalized)) return null
  const bic = lookupBicByClearing(`${normalized.slice(4, 7)}0`)
  return bic ? (BANK_BY_BIC[bic] ?? null) : null
}

/**
 * The instruction bank for a payment file paid from `payingIban`: that
 * account's bank, else the stored salary_default_bank when it is one of the
 * four ('other' and null answer null).
 */
export function salaryInstructionBank(
  payingIban: string | null | undefined,
  storedBank: string | null | undefined,
): SalaryInstructionBank | null {
  const fromAccount = salaryInstructionBankFromIban(payingIban)
  if (fromAccount) return fromAccount
  return storedBank && INSTRUCTION_BANKS.has(storedBank) ? (storedBank as SalaryInstructionBank) : null
}
