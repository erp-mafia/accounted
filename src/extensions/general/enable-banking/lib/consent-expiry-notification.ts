/**
 * The consent expiry mail lives in core (lib/bank-sync) since the Open
 * Payments cron sends the same one; this module keeps the extension's import
 * path.
 */
export { sendConsentExpiryNotification } from '@/lib/bank-sync/consent-expiry-notification'
