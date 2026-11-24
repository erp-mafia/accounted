/**
 * The link that opens the BankID app on this device with an autostart token,
 * shared by the payment signing (BankIdSigningFlow), the bank reading
 * consent (BankIdChallengeView) and the BankID sign-in (auth/BankIdAuth).
 * On a phone it is always a link the person taps: a navigation started after
 * an await has no tap behind it, and mobile browsers then load the link as a
 * web page instead of opening the app.
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
 *     Safari tab and would open the return in a new one. The redirect is the
 *     page with a fragment of its own for this order (#bankid-...), as
 *     BankID's return URL guide says (developers.bankid.com/how-to-guides/
 *     return-url: the exact URL of the tab, a nonce in the fragment). Safari
 *     then comes back to the tab as a jump within the page, which keeps its
 *     polling; the page's own URL as it was made Safari reload the tab, which
 *     dropped the polling. The fragment is a mark, not a credential: nothing
 *     reads it except a page that wants to know it is a BankID return.
 *   - Android: the universal link with redirect=null. The BankID app returns
 *     through the task stack; a real redirect URL would spawn a new tab or
 *     Chrome instance instead (components/auth/BankIdAuth.tsx learned this).
 *   - Android in Samsung Internet, Firefox or Edge: the bankid:/// scheme with
 *     redirect=null. These browsers do not hand the app.bankid.com link to the
 *     app: they load it in the tab, where BankID's own page says
 *     "BankID-appen kunde inte startas" (crm#2077; the ActiveLogin library
 *     found the same in its Android browser tests and falls back the same way).
 */

export interface BankIdDevice {
  /** A phone or tablet: the BankID app lives on the same device as the browser. */
  mobile: boolean
  /** An iPhone or iPad, where the app returns to the page named in `redirect`. */
  ios: boolean
  /** A phone browser that opens the BankID app from an https://app.bankid.com link. */
  appLink: boolean
  /** The page to come back to; null when there is no page (server render). */
  pageUrl: string | null
}

/** The device from the browser's user agent and location; a desktop without a page on the server. */
export function detectBankIdDevice(userAgent: string | null = typeof navigator === 'undefined' ? null : navigator.userAgent, pageUrl: string | null = typeof window === 'undefined' ? null : window.location.href): BankIdDevice {
  const ua = userAgent ?? ''
  const ios = /iPhone|iPad|iPod/i.test(ua)
  const mobile = ios || /Android/i.test(ua)
  const appLink = ios || (mobile && !/SamsungBrowser|Firefox|EdgA/i.test(ua))
  return { mobile, ios, appLink, pageUrl }
}

/** The BankID app link for an autostart token on this device (see the module note). */
export function bankIdAutostartHref(token: string, device: BankIdDevice = detectBankIdDevice()): string {
  const autostart = `autostarttoken=${encodeURIComponent(token)}`
  if (!device.mobile || !device.appLink) return `bankid:///?${autostart}&redirect=null`
  const redirect = device.ios && device.pageUrl ? encodeURIComponent(bankIdReturnUrl(device.pageUrl, token)) : 'null'
  return `https://app.bankid.com/?${autostart}&redirect=${redirect}`
}

const RETURN_FRAGMENT_PREFIX = '#bankid-'

/**
 * The page the BankID app returns to on an iPhone: the page without its
 * fragment, plus a fragment for this order. One per order, because a return
 * URL equal to the tab's current one (a second attempt from a tab that already
 * came back once) is the reload again. Derived from the token so a render
 * gives the same link every time, and hashed so the token, which starts the
 * order, stays out of the browser history.
 */
export function bankIdReturnUrl(pageUrl: string, token: string): string {
  const fragment = pageUrl.indexOf('#')
  const page = fragment === -1 ? pageUrl : pageUrl.slice(0, fragment)
  return `${page}${RETURN_FRAGMENT_PREFIX}${fnv1a(token).toString(36)}`
}

/** True when a page was opened by the BankID app's return (`location.hash`). */
export function isBankIdReturn(hash: string): boolean {
  return hash.startsWith(RETURN_FRAGMENT_PREFIX)
}

/** 32-bit FNV-1a: a short value that differs per token and does not reveal it. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
