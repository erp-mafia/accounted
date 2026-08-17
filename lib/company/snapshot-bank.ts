import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'

/**
 * Extract the company's bankgiro number from the cached TIC company snapshot
 * (companies.tic_snapshot). The snapshot's BANKUPPGIFTER rows are registry
 * display data from Bolagsverket and are never read by the payment-file
 * generators; those read company_settings.bankgiro. This helper bridges the
 * two as a suggestion only: the user still confirms and saves the value.
 *
 * Returns the raw digits (no hyphen) of the first bankgiro-typed account that
 * passes the Luhn check, or null. The snapshot is unvalidated registry JSON,
 * so every level is checked defensively.
 */
export function bankgiroFromTicSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const accounts = (snapshot as { bankAccounts?: unknown }).bankAccounts
  if (!Array.isArray(accounts)) return null
  for (const entry of accounts) {
    if (!entry || typeof entry !== 'object') continue
    const { type, accountNumber } = entry as { type?: unknown; accountNumber?: unknown }
    if (type !== 'bankgiro' || typeof accountNumber !== 'string') continue
    const digits = accountNumber.replace(/[-\s]/g, '')
    if (validateBankgiroNumber(digits)) return digits
  }
  return null
}
