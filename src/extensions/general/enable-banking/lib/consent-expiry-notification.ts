/**
 * The consent expiry mail lives in core (lib/bank-sync) since the Open
 * Payments cron sends the same one; this module keeps the extension's import
 * path and adds the one thing that is Enable Banking's alone: once the feed
 * has ended (lib/bank-feed/switch-campaign.ts enableBankingSunset) no consent
 * mail goes for an Enable Banking row. The consent is moot: renewing it at a
 * provider that is gone would only cost a BankID round trip, and the switch
 * campaign's own mails say what to do instead.
 */
import { sendConsentExpiryNotification as sendCore } from '@/lib/bank-sync/consent-expiry-notification'
import { enableBankingSunset } from '@/lib/bank-feed/switch-campaign'

export const sendConsentExpiryNotification: typeof sendCore = async (...args) => {
  if (enableBankingSunset()) return
  return sendCore(...args)
}
