/**
 * The stored VAT submission state of one period (extension_data
 * `submission_<YYYYMM>`), as the lock step writes it: the one-click chain
 * (vat-submit.ts, also behind an approved submit_vat_declaration in
 * /pending) and the step-by-step lock route. The kvittens cron flips it to
 * 'signed' once Skatteverket has the filing.
 *
 * Read back for the Moms page: a declaration locked for signing elsewhere
 * (approved in /pending, or before a reload) showed nothing there, so nobody
 * was prompted to sign and the filing never reached Skatteverket (crm#1478).
 */

export interface AwaitingSignature {
  /** Skatteverket's BankID signing page for the locked declaration. */
  signeringsLank: string
  /** When the declaration was locked, ISO 8601. */
  updatedAt: string | null
}

/** The period's signing link while its declaration waits for a signature, else null. */
export function awaitingSignatureOf(raw: unknown): AwaitingSignature | null {
  let state: unknown = raw
  if (typeof raw === 'string') {
    try {
      state = JSON.parse(raw)
    } catch {
      // Safe to ignore: an unreadable state only means no signing prompt;
      // the page shows what it showed before and nothing is written.
      return null
    }
  }
  if (state == null || typeof state !== 'object') return null
  const { status, signeringsLank, updatedAt } = state as Record<string, unknown>
  if (status !== 'draft_locked') return null
  // Rendered as a link: only Skatteverket's https address, never a stored
  // value that could carry another scheme.
  if (typeof signeringsLank !== 'string' || !signeringsLank.startsWith('https://')) return null
  return { signeringsLank, updatedAt: typeof updatedAt === 'string' ? updatedAt : null }
}
