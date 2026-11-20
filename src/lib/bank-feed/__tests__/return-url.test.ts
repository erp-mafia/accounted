import { describe, expect, it } from 'vitest'
import { BANK_CONNECT_RETURN_PARAM, BANK_CONNECT_RETURN_SURFACES, bankConnectReturnUrl, isBankConnectReturnSurface } from '../return-url'

describe('bankConnectReturnUrl', () => {
  it('names the connection on each entry point\'s own page, on the given origin', () => {
    expect(BANK_CONNECT_RETURN_PARAM).toBe('bank_connect')
    expect(bankConnectReturnUrl('https://app.accounted.se', 'connections', 'c-1')).toBe('https://app.accounted.se/settings/connections?bank_connect=c-1')
    expect(bankConnectReturnUrl('https://app.accounted.se', 'banking', 'c-1')).toBe('https://app.accounted.se/settings/banking?bank_connect=c-1')
    expect(bankConnectReturnUrl('https://brand.example.se', 'onboarding', 'c-1')).toBe('https://brand.example.se/onboarding/books?station=bank&bank_connect=c-1')
  })

  it('knows its surfaces and nothing else', () => {
    for (const surface of BANK_CONNECT_RETURN_SURFACES) expect(isBankConnectReturnSurface(surface)).toBe(true)
    expect(isBankConnectReturnSurface('/etc/passwd')).toBe(false)
    expect(isBankConnectReturnSurface(null)).toBe(false)
  })
})
