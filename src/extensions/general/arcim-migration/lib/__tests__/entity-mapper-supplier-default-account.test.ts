import { describe, expect, it } from 'vitest'
import type { SupplierDto } from '@/lib/providers/dto'
import { mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { mapSupplier, proposedExpenseAccount } from '../entity-mapper'

/**
 * A Fortnox supplier names the account its invoices are booked to
 * (PreDefinedAccount). The import set no default account at all, so every
 * migrated supplier had to be given one again (crm#1744). It is kept only
 * when the company's chart holds it active, and only when it is a cost
 * account the supplier form could have chosen: a default naming an account
 * the chart lacks would be refused at booking on every invoice.
 */

const supplier = (defaultExpenseAccount?: string): SupplierDto => ({
  id: '7', supplierNumber: '7', active: true, party: { name: 'Leverantör AB', identifications: [] }, defaultExpenseAccount,
})

describe('mapFortnoxToSupplier: the predefined account', () => {
  it('reads PreDefinedAccount, and an empty one as none', () => {
    expect(mapFortnoxToSupplier({ SupplierNumber: '7', Name: 'Leverantör AB', PreDefinedAccount: '5410' }).defaultExpenseAccount)
      .toBe('5410')
    expect(mapFortnoxToSupplier({ SupplierNumber: '7', Name: 'Leverantör AB', PreDefinedAccount: '' }).defaultExpenseAccount)
      .toBeUndefined()
  })
})

describe('mapSupplier: the default expense account', () => {
  it('writes the proposed account the chart holds active', () => {
    expect(mapSupplier(supplier('5410'), 'u', 'c', new Set(['5410'])).default_expense_account).toBe('5410')
  })

  it('writes none when the chart does not hold it, or was not read', () => {
    expect(mapSupplier(supplier('5410'), 'u', 'c', new Set(['6110'])).default_expense_account).toBeNull()
    expect(mapSupplier(supplier('5410'), 'u', 'c', new Set()).default_expense_account).toBeNull()
    expect(mapSupplier(supplier('5410'), 'u', 'c').default_expense_account).toBeNull()
    expect(mapSupplier(supplier(), 'u', 'c', new Set(['5410'])).default_expense_account).toBeNull()
  })

  it('writes no account outside the cost classes the supplier form offers, even one the chart holds', () => {
    for (const account of ['1220', '2440', '3010', '8410']) {
      expect(mapSupplier(supplier(account), 'u', 'c', new Set([account])).default_expense_account).toBeNull()
    }
  })
})

describe('proposedExpenseAccount', () => {
  it('answers a four-digit account of class 4-7, trimmed', () => {
    expect(proposedExpenseAccount({ defaultExpenseAccount: ' 4010 ' })).toBe('4010')
    expect(proposedExpenseAccount({ defaultExpenseAccount: '7699' })).toBe('7699')
  })

  it('answers none for anything else', () => {
    for (const account of [undefined, '', '401', '40100', '3010', '8410', 'abcd']) {
      expect(proposedExpenseAccount({ defaultExpenseAccount: account })).toBeNull()
    }
  })
})
