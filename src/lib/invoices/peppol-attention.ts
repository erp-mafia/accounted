/**
 * What the invoice page says about the latest Peppol delivery, when it needs
 * the user (one sentence, convention 6).
 *
 * `submission_accepted` means the access point took the document from us. It
 * is not Corner 3 transport and not the buyer's receipt, and it is not a
 * failure either. Two ages of it read differently:
 *
 *   unconfirmed  over an hour: news of delivery is normally back by now
 *   unreported   over a day: the access point is not reporting an outcome
 *                back to us. The page then says exactly that, and that the
 *                buyer is the one who can tell, instead of a "not yet" that
 *                reads like a delivery that did not happen (crm#1803).
 */
export type PeppolDeliveryAttention = 'failed' | 'unconfirmed' | 'unreported'

// A delivery that ended without reaching the buyer; sending again stages a
// new delivery that replaces it.
const FAILED_DELIVERY_STATUSES = new Set(['failed', 'no_route'])
// How long the access point may hold a submission without news of delivery
// before the page says so.
export const PEPPOL_UNCONFIRMED_AFTER_MS = 60 * 60 * 1000
// After this long without an outcome the wait is no longer the news: the
// missing report is.
export const PEPPOL_UNREPORTED_AFTER_MS = 24 * 60 * 60 * 1000

export function peppolDeliveryAttention(
  delivery: { status: string; status_at: string } | null,
  readAt: number | null,
): PeppolDeliveryAttention | null {
  if (!delivery) return null
  if (FAILED_DELIVERY_STATUSES.has(delivery.status)) return 'failed'
  if (delivery.status !== 'submission_accepted' || readAt === null) return null
  const heldFor = readAt - Date.parse(delivery.status_at)
  if (heldFor > PEPPOL_UNREPORTED_AFTER_MS) return 'unreported'
  if (heldFor > PEPPOL_UNCONFIRMED_AFTER_MS) return 'unconfirmed'
  return null
}

/**
 * The 'unreported' state for a reader that is not the invoice page: the v1 API
 * and the MCP tools, where an agent otherwise sees only the raw
 * `submission_accepted` and reads a delivery held for days as one that did not
 * happen (crm#1803). Same rule as the page, never a second one.
 */
export const PEPPOL_OUTCOME_UNREPORTED_HINT =
  'The access point accepted the invoice but has not reported whether it was delivered. This is not a failure: do not resend. The buyer can confirm receipt.'

export function peppolOutcomeUnreported(
  delivery: { status: string; status_at: string },
  readAt: number,
): { outcome_unreported: true; outcome_hint: string } | null {
  return peppolDeliveryAttention(delivery, readAt) === 'unreported'
    ? { outcome_unreported: true, outcome_hint: PEPPOL_OUTCOME_UNREPORTED_HINT }
    : null
}
