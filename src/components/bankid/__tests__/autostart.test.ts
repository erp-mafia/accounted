import { describe, expect, it } from 'vitest'
import { bankIdAutostartHref, detectBankIdDevice } from '../autostart'

const PAGE = 'https://app.accounted.se/settings/connections?tab=bank'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

describe('detectBankIdDevice', () => {
  it('tells phones from computers by the user agent and keeps the page to come back to', () => {
    expect(detectBankIdDevice(IPHONE, PAGE)).toEqual({ mobile: true, ios: true, pageUrl: PAGE })
    expect(detectBankIdDevice(ANDROID, PAGE)).toEqual({ mobile: true, ios: false, pageUrl: PAGE })
    expect(detectBankIdDevice(MAC, PAGE)).toEqual({ mobile: false, ios: false, pageUrl: PAGE })
    // On the server there is neither a user agent nor a page: a desktop link, which the browser never renders anyway.
    expect(detectBankIdDevice(null, null)).toEqual({ mobile: false, ios: false, pageUrl: null })
  })
})

describe('bankIdAutostartHref', () => {
  it('keeps the bankid:/// scheme with redirect=null on a computer, the token URL-encoded', () => {
    expect(bankIdAutostartHref('0a5f9137-7cb2-4d2f-b762-bfab4ad9d35f', detectBankIdDevice(MAC, PAGE))).toBe('bankid:///?autostarttoken=0a5f9137-7cb2-4d2f-b762-bfab4ad9d35f&redirect=null')
    expect(bankIdAutostartHref('a b&c', detectBankIdDevice(MAC, PAGE))).toBe('bankid:///?autostarttoken=a%20b%26c&redirect=null')
  })

  it('uses the universal link with the current page as the redirect on an iPhone, so the app comes back to the polling page', () => {
    expect(bankIdAutostartHref('tok', detectBankIdDevice(IPHONE, PAGE))).toBe(`https://app.bankid.com/?autostarttoken=tok&redirect=${encodeURIComponent(PAGE)}`)
    // No page known: nothing to come back to, the app returns on its own.
    expect(bankIdAutostartHref('tok', { mobile: true, ios: true, pageUrl: null })).toBe('https://app.bankid.com/?autostarttoken=tok&redirect=null')
  })

  it('uses the universal link with redirect=null on Android, where the app returns through the task stack', () => {
    expect(bankIdAutostartHref('tok', detectBankIdDevice(ANDROID, PAGE))).toBe('https://app.bankid.com/?autostarttoken=tok&redirect=null')
  })

  it('reads the device itself when none is given (a desktop in this test runtime)', () => {
    expect(bankIdAutostartHref('tok')).toBe('bankid:///?autostarttoken=tok&redirect=null')
  })
})
