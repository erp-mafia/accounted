/**
 * Interim suspension of the kontantmetoden year-end cut-off (#3440).
 *
 * The cut-off (kontantmetod-cutoff.ts) declares the moms on invoices unpaid at
 * year end in the final VAT period, and its vändning on day one of the next
 * year is excluded from the VAT RPCs. When such an invoice is then paid, the
 * normal kontantmetoden cash entry books revenue and moms again, so the same
 * moms is declared twice. The fix (årsomföring) is a larger change; until it
 * ships, nobody may post a cut-off. Production has never posted one, so no
 * data needs repair.
 *
 * This module is the single switch. Every door reads it:
 *   - staging: gnubok_post_kontantmetod_cutoff (MCP server) refuses to stage;
 *   - approval: commitPendingOperation refuses a staged post_kontantmetod_cutoff
 *     BEFORE the atomic claim, so the operation stays pending and nothing is
 *     written;
 *   - readiness: validateYearEndReadiness keeps the KONTANTMETOD_CUTOFF_REQUIRED
 *     blocker but says the cut-off is temporarily unavailable.
 *
 * Lifting it: the fix PR deletes this file. The compiler then names every call
 * site; tests that lift the suspension carry the marker "i3440-suspension" and
 * drop their mock of this module. The registry code KONTANTMETOD_CUTOFF_SUSPENDED
 * stays registered (codes are stable once shipped).
 */
import { getErrorEntry } from '@/lib/errors/structured-errors'

export const KONTANTMETOD_CUTOFF_SUSPENDED_CODE = 'KONTANTMETOD_CUTOFF_SUSPENDED' as const

/** True while posting a kontantmetoden cut-off is refused (#3440). */
export function isKontantmetodCutoffSuspended(): boolean {
  return true
}

/**
 * The Swedish sentence every surface uses to say the cut-off is suspended:
 * the registry's message_sv, so the readiness blocker, the /pending toast and
 * the agent envelope say the same thing.
 */
export function kontantmetodCutoffSuspendedMessageSv(): string {
  return getErrorEntry(KONTANTMETOD_CUTOFF_SUSPENDED_CODE)?.message_sv ?? KONTANTMETOD_CUTOFF_SUSPENDED_CODE
}
