import { createLogger } from '@/lib/logger'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

const log = createLogger('invoices/deduction-personnummer')

/**
 * The display form of an invoice's ROT/RUT personnummer: `YYYYMMDD-XXXX`,
 * birth date visible and the last four digits hidden. Same convention as the
 * payroll roster (maskPersonnummer), so every surface that shows a
 * personnummer in the app reads the same way.
 *
 * Invoices store the personnummer only as AES-256-GCM ciphertext
 * (`deduction_personnummer_encrypted`) plus `deduction_personnummer_last4`.
 * The mask is computed on read, server-side, and never stored: a stored
 * mask next to the stored last4 would hand any reader the full number by
 * concatenation. That is also why the browser never gets both.
 *
 * Never throws. Nothing stored (or an invoice without a claim) returns null,
 * and so does a ciphertext that cannot be decrypted (wrong key on a restored
 * or self-hosted database, corrupted row): the invoice must still render and
 * the PDF must still ship. Logs the failure without the value.
 */
export function maskedDeductionPersonnummer(
  invoice: { deduction_personnummer_encrypted?: string | null } | null | undefined,
): string | null {
  const encrypted = invoice?.deduction_personnummer_encrypted
  if (!encrypted) return null
  try {
    return maskPersonnummer(decryptPersonnummer(encrypted))
  } catch (err) {
    log.error('deduction personnummer decrypt failed; rendering without it', {
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
