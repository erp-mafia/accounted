import { describe, expect, it } from 'vitest'
import { resolveCapabilities, type CapabilityInputs } from '@/lib/modules/capabilities'
import { ALL_STARTABLE } from '../decision'
import { inkorgCompany } from '../startable'

function capabilities(overrides: Partial<CapabilityInputs> = {}) {
  return resolveCapabilities({
    jurisdiction: 'SE',
    ledgerCurrency: 'SEK',
    entityType: 'aktiebolag',
    paysSalaries: null,
    entitled: new Set(),
    disabled: new Set(),
    selfHosted: false,
    ...overrides,
  })
}

const AB = { entityType: 'aktiebolag', accountingMethod: 'accrual' }
const EF = { entityType: 'enskild_firma', accountingMethod: 'cash' }

describe('inkorgCompany', () => {
  it('a company without a profile or a switch has every package on: the Inkorg it always had', () => {
    const company = inkorgCompany(capabilities(), AB)
    expect(company.startable).toEqual(ALL_STARTABLE)
    expect(company.ownerAccount).toBeNull()
  })

  it('the sole-trader profile has Leverantörsfakturor and Utlägg off; the owner\'s money is 2018 Egna insättningar', () => {
    const company = inkorgCompany(capabilities({ entityType: 'enskild_firma', profile: { id: 'sole-trader', version: 1 } }), EF)
    expect(company.startable).toEqual({ supplierInvoices: false, expenses: false, soleTrader: true, cashMethod: true })
    expect(company.ownerAccount).toBe('2018')
  })

  it('the company\'s own switch wins over its profile, both ways', () => {
    const on = inkorgCompany(
      capabilities({ profile: { id: 'sole-trader', version: 1 }, packageChoices: { 'supplier-invoices-and-payments': true } }),
      EF,
    )
    expect(on.startable.supplierInvoices).toBe(true)
    expect(on.startable.expenses).toBe(false)
    const off = inkorgCompany(capabilities({ packageChoices: { expenses: false } }), AB)
    expect(off.startable).toEqual({ ...ALL_STARTABLE, expenses: false })
  })

  it('a package winding down starts nothing, as the start gate refuses it', () => {
    const company = inkorgCompany(
      capabilities({ packageChoices: { 'supplier-invoices-and-payments': false }, openObligations: { 'supplier-invoices-and-payments': ['open_supplier_invoices'] } }),
      AB,
    )
    expect(company.startable.supplierInvoices).toBe(false)
  })

  it('outside the package\'s country it starts nothing either', () => {
    expect(inkorgCompany(capabilities({ jurisdiction: 'NO' }), AB).startable.supplierInvoices).toBe(false)
  })

  it('counts every package on when the capabilities could not be read, as the start gate does', () => {
    expect(inkorgCompany(null, EF).startable).toEqual({ supplierInvoices: true, expenses: true, soleTrader: true, cashMethod: true })
  })

  it('reads the legal form from its profile and never guesses one', () => {
    for (const entityType of ['aktiebolag', 'ideell_forening', 'ekonomisk_forening']) {
      const company = inkorgCompany(capabilities(), { entityType, accountingMethod: 'cash' })
      expect(company.startable.soleTrader, entityType).toBe(false)
      expect(company.ownerAccount, entityType).toBeNull()
    }
    for (const entityType of [null, undefined, 'handelsbolag']) {
      const company = inkorgCompany(capabilities(), { entityType, accountingMethod: 'cash' })
      expect(company.startable.soleTrader).toBe(false)
      expect(company.ownerAccount).toBeNull()
    }
  })

  it('kontantmetoden only when the company says cash', () => {
    expect(inkorgCompany(capabilities(), { ...AB, accountingMethod: 'cash' }).startable.cashMethod).toBe(true)
    expect(inkorgCompany(capabilities(), { ...AB, accountingMethod: 'accrual' }).startable.cashMethod).toBe(false)
    expect(inkorgCompany(capabilities(), { ...AB, accountingMethod: null }).startable.cashMethod).toBe(false)
  })
})
