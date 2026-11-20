/**
 * What the Kopplingar row for bank payments shows, from the availability
 * answer (availability.ts):
 *
 *   on             payments are open to the company: the row leads to the
 *                  Betalningar via banken settings page
 *   subscription   a paid plan is all that is missing (the seeded trial
 *                  without a card, a trial that ended, a subscription that
 *                  was cancelled): the row stays, says so and leads to
 *                  Abonnemang, so the feature can be found before it is on
 *   hidden         nothing a person can do here opens it: no provider on the
 *                  installation, outside the pilot, a sandbox company, or an
 *                  answer that could not be read
 *
 * On a self-host a missing plan is the connector's matter, never a card
 * under Abonnemang (components/billing/UpgradeNote.tsx draws the same line),
 * so the row stays hidden there.
 *
 * Pure, and only about what is shown: who may pay through the bank is
 * switched-on.ts and pilot.ts alone.
 */

import type { PaymentsUnavailableReason } from './switched-on'

export type PaymentsConnectionRow = 'on' | 'subscription' | 'hidden'

/** What the row needs of the availability answer (availability.ts PaymentsAvailability). */
export interface PaymentsConnectionAnswer {
  available: boolean
  reason: PaymentsUnavailableReason | null
}

/** The row's state. A null answer is one that could not be read. */
export function paymentsConnectionRow(
  answer: PaymentsConnectionAnswer | null,
  options: { selfHosted?: boolean } = {},
): PaymentsConnectionRow {
  if (!answer) return 'hidden'
  if (answer.available) return 'on'
  if (answer.reason === 'subscription' && !options.selfHosted) return 'subscription'
  return 'hidden'
}
