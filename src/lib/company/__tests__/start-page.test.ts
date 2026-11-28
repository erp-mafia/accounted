import { describe, it, expect } from 'vitest'
import {
  DEFAULT_START_PAGE,
  START_PAGES,
  isStartPagePath,
  startPageFor,
  startPageOpens,
  storedStartPages,
  type StartPageContext,
} from '../start-page'

const COMPANY_A = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const COMPANY_B = '0b5f3c2a-9d41-4e6b-8a7c-1d2e3f4a5b6c'

const owner: StartPageContext = { role: 'owner', bookingScreenEnabled: true }

describe('startPageFor', () => {
  it('is Att göra without a choice, as before the setting existed', () => {
    expect(startPageFor(undefined, COMPANY_A, owner)).toBe(DEFAULT_START_PAGE)
    expect(startPageFor({}, COMPANY_A, owner).path).toBe('/')
    expect(startPageFor(null, COMPANY_A, owner).path).toBe('/')
  })

  it('follows the choice for the company, and only for that company', () => {
    const choices = { [COMPANY_A]: 'bookkeeping', [COMPANY_B]: 'supplier_invoices' }
    expect(startPageFor(choices, COMPANY_A, owner).path).toBe('/bookkeeping')
    expect(startPageFor(choices, COMPANY_B, owner).path).toBe('/supplier-invoices')
    expect(startPageFor(choices, '11111111-2222-4333-8444-555555555555', owner).path).toBe('/')
  })

  it('is Att göra without an active company', () => {
    expect(startPageFor({ [COMPANY_A]: 'reports' }, null, owner).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: 'reports' }, undefined, owner).path).toBe('/')
  })

  it('reads an unknown or malformed choice as no choice', () => {
    expect(startPageFor({ [COMPANY_A]: 'payroll' }, COMPANY_A, owner).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: '/settings' }, COMPANY_A, owner).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: 42 }, COMPANY_A, owner).path).toBe('/')
    expect(startPageFor([COMPANY_A], COMPANY_A, owner).path).toBe('/')
    expect(startPageFor('bookkeeping', COMPANY_A, owner).path).toBe('/')
  })

  it('lands the invoicing role on Att göra when it chose a page it cannot open', () => {
    const invoicer: StartPageContext = { role: 'invoicer', bookingScreenEnabled: true }
    expect(startPageFor({ [COMPANY_A]: 'bookkeeping' }, COMPANY_A, invoicer).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: 'supplier_invoices' }, COMPANY_A, invoicer).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: 'reports' }, COMPANY_A, invoicer).path).toBe('/')
    expect(startPageFor({ [COMPANY_A]: 'invoices' }, COMPANY_A, invoicer).path).toBe('/invoices')
  })

  it('lands on Att göra when the role is not known', () => {
    for (const role of [null, undefined, '']) {
      expect(startPageFor({ [COMPANY_A]: 'invoices' }, COMPANY_A, { role, bookingScreenEnabled: true }).path).toBe('/')
    }
  })

  it('lands on Att göra for Att bokföra outside the booking screen rollout', () => {
    const choices = { [COMPANY_A]: 'to_book' }
    expect(startPageFor(choices, COMPANY_A, owner).path).toBe('/att-bokfora')
    expect(startPageFor(choices, COMPANY_A, { role: 'owner', bookingScreenEnabled: false }).path).toBe('/')
  })

  it('opens every page for owner, admin, member and viewer', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      for (const page of START_PAGES) {
        expect(startPageFor({ [COMPANY_A]: page.id }, COMPANY_A, { role, bookingScreenEnabled: true })).toBe(page)
      }
    }
  })
})

describe('startPageOpens', () => {
  it('always opens Att göra, whatever the role', () => {
    for (const role of [null, 'invoicer', 'viewer', 'owner']) {
      expect(startPageOpens('todo', { role, bookingScreenEnabled: false })).toBe(true)
    }
  })

  it('offers the invoicing role only Att göra and Kundfakturor', () => {
    const invoicer: StartPageContext = { role: 'invoicer', bookingScreenEnabled: true }
    expect(START_PAGES.filter((p) => startPageOpens(p.id, invoicer)).map((p) => p.id)).toEqual(['todo', 'invoices'])
  })
})

describe('isStartPagePath', () => {
  it('names the start pages and nothing else', () => {
    for (const page of START_PAGES) expect(isStartPagePath(page.path)).toBe(true)
    for (const value of ['/clients', '/settings', 'https://evil.example/', '//evil.example', '', null, 1]) {
      expect(isStartPagePath(value)).toBe(false)
    }
  })
})

describe('storedStartPages', () => {
  it('keeps the known choices and drops the rest', () => {
    expect(storedStartPages({ [COMPANY_A]: 'reports', [COMPANY_B]: 'nope', x: 3 })).toEqual({ [COMPANY_A]: 'reports' })
    expect(storedStartPages(null)).toEqual({})
    expect(storedStartPages(['reports'])).toEqual({})
  })
})
