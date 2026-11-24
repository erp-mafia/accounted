/**
 * The consent expiry mail lives in core (lib/bank-sync) since the Open
 * Payments cron sends the same one; this module keeps the extension's import
 * path and adds the one thing that is Enable Banking's alone: once the switch
 * campaign is on (lib/bank-feed/switch-campaign.ts enableBankingClosedToNew)
 * no consent mail goes for an Enable Banking row. A renewal there is refused
 * from then on and the feed ends on the deadline anyway, so the mail would
 * ask for a BankID round trip that leads nowhere; the switch campaign's own
 * mails say what to do instead.
 */
import { sendConsentExpiryNotification as sendCore } from '@/lib/bank-sync/consent-expiry-notification'
import { enableBankingClosedToNew } from '@/lib/bank-feed/switch-campaign'

export const sendConsentExpiryNotification: typeof sendCore = async (...args) => {
  if (enableBankingClosedToNew()) return
  return sendCore(...args)
}
