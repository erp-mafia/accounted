/**
 * The link that opens the BankID app on this device with an autostart token,
 * shared by the payment signing (BankIdSigningFlow) and the bank reading
 * consent (BankIdChallengeView).
 *
 * Open Payments gives the form
 * https://app.bankid.com/?autostarttoken={token}&redirect={uri} and says to
 * set the redirect for mobile.
 *
 *   - Desktop: the bankid:/// scheme with redirect=null. The BankID app on a
 *     computer sits beside the browser; the page keeps polling.
 *   - iPhone/iPad: the universal link with the current page as the redirect,
 *     so the BankID app hands the person back to this very page, which
 *     re-polls on return. The bankid:/// scheme has no association with the
 *     Safari tab and would open the return in a new one.
 *   - Android: the universal link with redirect=null. The BankID app returns
 *     through the task stack; a real redirect URL would spawn a new tab or
 *     Chrome instance instead (components/auth/BankIdAuth.tsx learned this).
 */

export interface BankIdDevice {
  /** A phone or tablet: the BankID app lives on the same device as the browser. */
  mobile: boolean
  /** An iPhone or iPad, where the app returns to the page named in `redirect`. */
  ios: boolean
  /** The page to come back to; null when there is no page (server render). */
  pageUrl: string | null
}

/** The device from the browser's user agent and location; a desktop without a page on the server. */
export function detectBankIdDevice(userAgent: string | null = typeof navigator === 'undefined' ? null : navigator.userAgent, pageUrl: string | null = typeof window === 'undefined' ? null : window.location.href): BankIdDevice {
  const ua = userAgent ?? ''
  const ios = /iPhone|iPad|iPod/i.test(ua)
  const mobile = ios || /Android/i.test(ua)
  return { mobile, ios, pageUrl }
}

/** The BankID app link for an autostart token on this device (see the module note). */
export function bankIdAutostartHref(token: string, device: BankIdDevice = detectBankIdDevice()): string {
  const autostart = `autostarttoken=${encodeURIComponent(token)}`
  if (!device.mobile) return `bankid:///?${autostart}&redirect=null`
  const redirect = device.ios && device.pageUrl ? encodeURIComponent(device.pageUrl) : 'null'
  return `https://app.bankid.com/?${autostart}&redirect=${redirect}`
}
