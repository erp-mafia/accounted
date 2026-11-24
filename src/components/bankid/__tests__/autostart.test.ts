import { describe, expect, it } from 'vitest'
import { bankIdAutostartHref, bankIdReturnUrl, detectBankIdDevice, isBankIdReturn } from '../autostart'

const PAGE = 'https://app.accounted.se/settings/connections?tab=bank'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0'
const ANDROID_EDGE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

describe('detectBankIdDevice', () => {
  it('tells phones from computers by the user agent and keeps the page to come back to', () => {
    expect(detectBankIdDevice(IPHONE, PAGE)).toEqual({ mobile: true, ios: true, appLink: true, pageUrl: PAGE })
    expect(detectBankIdDevice(ANDROID, PAGE)).toEqual({ mobile: true, ios: false, appLink: true, pageUrl: PAGE })
    expect(detectBankIdDevice(MAC, PAGE)).toEqual({ mobile: false, ios: false, appLink: false, pageUrl: PAGE })
    // On the server there is neither a user agent nor a page: a desktop link, which the browser never renders anyway.
    expect(detectBankIdDevice(null, null)).toEqual({ mobile: false, ios: false, appLink: false, pageUrl: null })
  })
})

describe('bankIdAutostartHref', () => {
  it('keeps the bankid:/// scheme with redirect=null on a computer, the token URL-encoded', () => {
    expect(bankIdAutostartHref('0a5f9137-7cb2-4d2f-b762-bfab4ad9d35f', detectBankIdDevice(MAC, PAGE))).toBe('bankid:///?autostarttoken=0a5f9137-7cb2-4d2f-b762-bfab4ad9d35f&redirect=null')
    expect(bankIdAutostartHref('a b&c', detectBankIdDevice(MAC, PAGE))).toBe('bankid:///?autostarttoken=a%20b%26c&redirect=null')
  })

  it('uses the universal link with the current page as the redirect on an iPhone, so the app comes back to the polling page', () => {
    expect(bankIdAutostartHref('tok', detectBankIdDevice(IPHONE, PAGE))).toBe(`https://app.bankid.com/?autostarttoken=tok&redirect=${encodeURIComponent(bankIdReturnUrl(PAGE, 'tok'))}`)
    // No page known: nothing to come back to, the app returns on its own.
    expect(bankIdAutostartHref('tok', { mobile: true, ios: true, appLink: true, pageUrl: null })).toBe('https://app.bankid.com/?autostarttoken=tok&redirect=null')
  })

  it('returns an iPhone to the page with a fragment of its own, so Safari jumps within the tab instead of reloading it', () => {
    const href = new URL(bankIdAutostartHref('0a5f9137-7cb2-4d2f-b762-bfab4ad9d35f', detectBankIdDevice(IPHONE, PAGE)))
    const back = new URL(href.searchParams.get('redirect') as string)
    // The exact page (path and query) the tab is on, only the fragment added.
    expect(`${back.origin}${back.pathname}${back.search}`).toBe(PAGE)
    expect(back.hash).toMatch(/^#bankid-[0-9a-z]+$/)
    expect(isBankIdReturn(back.hash)).toBe(true)
    // The fragment never carries the token that starts the order.
    expect(back.hash).not.toContain('0a5f9137')
  })

  it('uses the universal link with redirect=null on Android, where the app returns through the task stack', () => {
    expect(bankIdAutostartHref('tok', detectBankIdDevice(ANDROID, PAGE))).toBe('https://app.bankid.com/?autostarttoken=tok&redirect=null')
  })

  it('uses the bankid:/// scheme on Android in Samsung Internet, Firefox and Edge, which load the universal link as a web page', () => {
    // A tap on https://app.bankid.com in these browsers shows BankID's own
    // "BankID-appen kunde inte startas" page in the tab instead of the app.
    for (const ua of [ANDROID_SAMSUNG, ANDROID_FIREFOX, ANDROID_EDGE]) {
      expect(bankIdAutostartHref('tok', detectBankIdDevice(ua, PAGE))).toBe('bankid:///?autostarttoken=tok&redirect=null')
    }
  })

  it('reads the device itself when none is given (a desktop in this test runtime)', () => {
    expect(bankIdAutostartHref('tok')).toBe('bankid:///?autostarttoken=tok&redirect=null')
  })
})

describe('bankIdReturnUrl', () => {
  it('gives the same link for the same order and a different one for the next order', () => {
    expect(bankIdReturnUrl(PAGE, 'first')).toBe(bankIdReturnUrl(PAGE, 'first'))
    expect(bankIdReturnUrl(PAGE, 'first')).not.toBe(bankIdReturnUrl(PAGE, 'second'))
  })

  it('replaces the fragment the page has, so a second attempt from a returned tab is not the same URL again', () => {
    const firstReturn = bankIdReturnUrl('https://app.accounted.se/login', 'first')
    const secondReturn = bankIdReturnUrl(firstReturn, 'second')
    expect(secondReturn).toBe(bankIdReturnUrl('https://app.accounted.se/login', 'second'))
    expect(secondReturn).not.toBe(firstReturn)
    expect(secondReturn.split('#')).toHaveLength(2)
  })
})

describe('isBankIdReturn', () => {
  it('tells a BankID return from any other fragment', () => {
    expect(isBankIdReturn(new URL(bankIdReturnUrl(PAGE, 'tok')).hash)).toBe(true)
    expect(isBankIdReturn('')).toBe(false)
    expect(isBankIdReturn('#members')).toBe(false)
    expect(isBankIdReturn('#ar-step-agm')).toBe(false)
  })
})
