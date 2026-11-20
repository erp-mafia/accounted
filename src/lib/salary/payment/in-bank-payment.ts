/**
 * The HINT the database raises with when a salary run is paid through the
 * bank (migration 20261027100000): taking the run back to review or draft,
 * or archiving a payment file, while a bank payment of the run is live.
 */
export const SALARY_IN_BANK_PAYMENT_HINT = 'salary_run_in_bank_payment'

/** Whether a database error is that refusal. */
export function isSalaryInBankPaymentError(error: unknown): boolean {
  return (error as { hint?: string | null } | null)?.hint === SALARY_IN_BANK_PAYMENT_HINT
}

/** Why a payment file is refused for such a run, for the dashboard's legacy `{ error }` envelope. */
export const SALARY_IN_BANK_PAYMENT_FILE_SV =
  'Lönen betalas via banken. Avbryt betalningarna under Betalningar innan du skapar en betalfil, annars betalas lönen ut två gånger.'
