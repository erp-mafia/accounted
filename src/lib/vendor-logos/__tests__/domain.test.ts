import { describe, expect, it } from 'vitest'
import { emailDomain, hostsInText, mainLabel, registrableDomain } from '../domain'

describe('registrableDomain', () => {
  it('keys the registrable domain, lower case, without www or a subdomain', () => {
    expect(registrableDomain('WWW.Telia.SE')).toBe('telia.se')
    expect(registrableDomain('pending.uber.com')).toBe('uber.com')
    expect(registrableDomain('cloud.google.com')).toBe('google.com')
    expect(registrableDomain('shop.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('x.ai')).toBe('x.ai')
  })

  it('refuses what is not a public host', () => {
    expect(registrableDomain('localhost')).toBeNull()
    expect(registrableDomain('10.0.0.1')).toBeNull()
    expect(registrableDomain('[::1]')).toBeNull()
    expect(registrableDomain('bad_label.se')).toBeNull()
    expect(registrableDomain('example.123')).toBeNull()
    expect(registrableDomain('')).toBeNull()
    expect(registrableDomain(null)).toBeNull()
  })

  it('with commonTldsOnly, refuses an uncommon TLD', () => {
    expect(registrableDomain('example.museum', { commonTldsOnly: true })).toBeNull()
    expect(registrableDomain('example.se', { commonTldsOnly: true })).toBe('example.se')
  })
})

describe('mainLabel', () => {
  it('is the label the brand is named by', () => {
    expect(mainLabel('telia.se')).toBe('telia')
    expect(mainLabel('bbc.co.uk')).toBe('bbc')
  })
})

describe('hostsInText', () => {
  it.each([
    ['APPLE.COM/BILL', ['apple.com']],
    ['inet.se', ['inet.se']],
    ['ELEVENLABS.IO', ['elevenlabs.io']],
    ['www.cinode.com', ['cinode.com']],
    ['shipmondo.com se', ['shipmondo.com']],
    ['UBR* PENDING.UBER.COM', ['uber.com']],
    ['SVEA*EDEKLARERA.SE', ['edeklarera.se']],
  ])('reads %s', (text, hosts) => {
    expect(hostsInText(text)).toEqual(hosts)
  })

  it('ignores mail addresses, amounts, broken hosts and legal forms', () => {
    expect(hostsInText('faktura@telia.se')).toEqual([])
    expect(hostsInText('Card transaction of 12.50 EUR')).toEqual([])
    expect(hostsInText('APPLE.COMBILL')).toEqual([])
    expect(hostsInText('HALLON AB.SE')).toEqual([])
    expect(hostsInText('3.se')).toEqual([])
    expect(hostsInText('example.museum')).toEqual([])
    expect(hostsInText(null)).toEqual([])
  })
})

describe('emailDomain', () => {
  it('reads a bare address and a header value', () => {
    expect(emailDomain('faktura@telia.se')).toBe('telia.se')
    expect(emailDomain('Telia <noreply@notify.telia.se>')).toBe('telia.se')
    expect(emailDomain('"Loopia AB" <info@loopia.se>')).toBe('loopia.se')
  })

  it('is null without an address', () => {
    expect(emailDomain('Telia')).toBeNull()
    expect(emailDomain(null)).toBeNull()
  })
})
