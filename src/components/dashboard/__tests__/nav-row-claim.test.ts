import { describe, it, expect } from 'vitest'
import { NAV_V2_COMPANY, activeSubHref, claimedRowActive } from '../nav-v2'

const invoicing = NAV_V2_COMPANY.find((item) => item.href === '/invoices')!

/** DashboardNav's rule: the claim first, then the URL's prefix match. */
function activeSub(pathname: string, claim: string | null) {
  return activeSubHref(invoicing, (href) => claimedRowActive(href, pathname, claim) ?? pathname.startsWith(href))
}

describe('claimedRowActive', () => {
  it('says nothing without a claim, so the URL decides', () => {
    expect(claimedRowActive('/invoices', '/invoices/new', null)).toBeUndefined()
  })

  it('lights the claimed row and turns off the row the URL matched', () => {
    expect(claimedRowActive('/quotes', '/invoices/new', '/quotes')).toBe(true)
    expect(claimedRowActive('/invoices', '/invoices/new', '/quotes')).toBe(false)
  })

  it('leaves rows the URL does not match to the URL rules', () => {
    expect(claimedRowActive('/customers', '/invoices/new', '/quotes')).toBeUndefined()
    expect(claimedRowActive('/', '/invoices/new', '/quotes')).toBeUndefined()
  })
})

describe('Fakturering sub-row with the editor', () => {
  it('puts a new offert under Offerter', () => {
    expect(activeSub('/invoices/new', '/quotes')).toBe('/quotes')
  })

  it('puts an offert edited at /invoices/[id]/edit under Offerter', () => {
    expect(activeSub('/invoices/abc/edit', '/quotes')).toBe('/quotes')
  })

  it('keeps a faktura, and the credit page, under Kundfakturor', () => {
    expect(activeSub('/invoices/new', null)).toBe('/invoices')
    expect(activeSub('/invoices/abc/credit', null)).toBe('/invoices')
  })
})
