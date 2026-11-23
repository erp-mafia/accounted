import { describe, expect, it } from 'vitest'
import { detectBankIdDevice } from '@/components/bankid/autostart'
import { autoStartSigningMethod, leadingSigningMethod, otherSigningMethod } from '../signing-method'

const PAGE = 'https://app.accounted.se/supplier-invoices/1'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

describe('the BankID way in for a payment signing, by device', () => {
  it.each([
    ['an iPhone', IPHONE],
    ['an Android phone', ANDROID],
    ['an Android phone in Samsung Internet', ANDROID_SAMSUNG],
  ])('on %s: never starts a QR by itself, and leads with BankID on this device, the QR second', (_, ua) => {
    const device = detectBankIdDevice(ua, PAGE)
    expect(autoStartSigningMethod(device)).toBeNull()
    expect(leadingSigningMethod(device)).toBe('same_device')
    expect(otherSigningMethod(device)).toBe('qr')
  })

  it.each([
    ['a Mac', MAC],
    ['a Windows computer', WINDOWS],
  ])('on %s: starts the QR as the dialog opens and leads with it, as before', (_, ua) => {
    const device = detectBankIdDevice(ua, PAGE)
    expect(autoStartSigningMethod(device)).toBe('qr')
    expect(leadingSigningMethod(device)).toBe('qr')
    expect(otherSigningMethod(device)).toBe('same_device')
  })

  it('treats a render without a user agent (the server) as a computer', () => {
    const device = detectBankIdDevice(null, null)
    expect(leadingSigningMethod(device)).toBe('qr')
    expect(autoStartSigningMethod(device)).toBe('qr')
  })
})
