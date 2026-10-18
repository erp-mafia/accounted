/**
 * VENDOR_LOGOS_FETCH switches the vendor-logo cron on (true or 1). Off by
 * default: until a founder sets it, the cron answers "skipped" and no
 * vendor website is ever contacted. Icons already stored keep showing
 * either way; the flag only governs fetching.
 */
export function vendorLogosFetchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.VENDOR_LOGOS_FETCH?.trim().toLowerCase()
  return value === 'true' || value === '1'
}
