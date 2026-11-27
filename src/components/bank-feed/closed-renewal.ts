import { enableBankingWayOn } from '@/lib/bank-feed/bank-coverage'
import { BANK_FILE_IMPORT_PATH, switchDeepLink } from '@/lib/bank-feed/switch-link'
import { fetchBankSwitchProgress, type BankSwitchProgressView } from './open-payments-client'

/**
 * Where an Enable Banking renewal goes instead while the switch campaign is
 * on: the server refuses every one before the bank then
 * (lib/bank-feed/switch-campaign.ts enableBankingClosedToNew). The switch
 * where it can be made, the bank file import otherwise (enableBankingWayOn),
 * the same place the connection's row on the bank page offers. Null while
 * renewals are open, or when the campaign could not be read.
 */
export function closedRenewalHref(
  progress: Pick<BankSwitchProgressView, 'campaign' | 'company'> | null,
  connection: { id: string; bank_name: string | null },
): string | null {
  if (!progress?.campaign.on) return null
  return enableBankingWayOn(connection.bank_name, Boolean(progress.company)) === 'switch'
    ? switchDeepLink(connection.id)
    : BANK_FILE_IMPORT_PATH
}

/**
 * closedRenewalHref for the company's campaign as the server reads it now.
 * Rejects when the campaign cannot be read. The transactions page loads this
 * module when a renewal is clicked, not with the page, which keeps the read
 * and the routing out of the page's first JavaScript.
 */
export async function closedRenewalDestination(connection: { id: string; bank_name: string | null }): Promise<string | null> {
  return closedRenewalHref(await fetchBankSwitchProgress(), connection)
}
