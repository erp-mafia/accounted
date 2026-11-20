import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildCustomerMetadataEnrichment,
  buildSupplierEnrichment,
  writeCustomerEnrichment,
  writeSupplierEnrichment,
} from '../customer-metadata'

describe('buildCustomerMetadataEnrichment', () => {
  const mapped = {
    contact_person: 'Anna Andersson',
    invoice_email_cc_addresses: ['finance@example.test'],
    invoice_email_bcc_addresses: ['archive@example.test'],
  }

  it('fills metadata that was never configured', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    }, mapped)).toEqual(mapped)
  })

  it('does not overwrite existing values or explicit clears', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: '',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: ['manual@example.test'],
    }, mapped)).toBeNull()
  })

  it('fills the org number on an org-less invoice stub, and leaves a set one alone', () => {
    // The invoice steps create org-less minimal customers for counterparties
    // the register never delivered; the register row that maps onto such a
    // stub by name brings the number.
    expect(buildCustomerMetadataEnrichment({
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: [],
      org_number: null,
    }, { org_number: '5566778899' })).toEqual({ org_number: '5566778899' })

    expect(buildCustomerMetadataEnrichment({
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: [],
      org_number: '5511111111',
    }, { org_number: '5566778899' })).toBeNull()
  })

  it('never gives an org number to an individual matched by name', () => {
    // A privatperson has no org number; a provider business record that maps
    // onto one by name must not put its number there.
    expect(buildCustomerMetadataEnrichment({
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: [],
      org_number: null,
      customer_type: 'individual',
    }, { org_number: '5566778899' })).toBeNull()
  })

  it('fills the customer number on a card that has none, and leaves a set or cleared one alone (crm#1744)', () => {
    const card = { contact_person: 'Anna Andersson', invoice_email_cc_addresses: [], invoice_email_bcc_addresses: [] }
    expect(buildCustomerMetadataEnrichment({ ...card, customer_number: null }, { customer_number: '1001' }))
      .toEqual({ customer_number: '1001' })
    expect(buildCustomerMetadataEnrichment({ ...card, customer_number: 'K-7' }, { customer_number: '1001' })).toBeNull()
    expect(buildCustomerMetadataEnrichment({ ...card, customer_number: '' }, { customer_number: '1001' })).toBeNull()
    expect(buildCustomerMetadataEnrichment({ ...card, customer_number: null }, { customer_number: null })).toBeNull()
    // A caller that did not read the column never fills it.
    expect(buildCustomerMetadataEnrichment(card, { customer_number: '1001' })).toBeNull()
  })

  it('does not turn unknown provider metadata into explicit empty values', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    }, {
      contact_person: null,
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: null,
    })).toBeNull()
  })
})

/** A card the invoice step created: a name and nothing to reach the customer by. */
const stubDetails = {
  contact_person: null,
  invoice_email_cc_addresses: null,
  invoice_email_bcc_addresses: null,
  org_number: '5566778899',
  customer_type: 'swedish_business',
  email: null,
  phone: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: null,
  country: 'SE',
  vat_number: null,
  notes: null,
}

/** What mapCustomer makes of the register record of the same customer. */
const registerRow = {
  name: 'Kund AB',
  org_number: '5566778899',
  contact_person: null,
  email: 'faktura@kund.example',
  phone: '08-123 45 67',
  address_line1: 'Storgatan 1',
  address_line2: null,
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  vat_number: 'SE556677889901',
  notes: 'Ring före leverans',
  invoice_email_cc_addresses: null,
  invoice_email_bcc_addresses: null,
}

describe('a matched card gets the details a new card would have had (crm#1436)', () => {
  it('fills phone, e-mail, address, VAT number and notes on a card that has none', () => {
    expect(buildCustomerMetadataEnrichment(stubDetails, registerRow)).toEqual({
      email: 'faktura@kund.example',
      phone: '08-123 45 67',
      address_line1: 'Storgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
      vat_number: 'SE556677889901',
      notes: 'Ring före leverans',
    })
  })

  it('never replaces a value the user typed, nor one the user cleared', () => {
    expect(buildCustomerMetadataEnrichment({
      ...stubDetails,
      phone: '070-999 99 99',
      email: '',
      vat_number: 'SE556677889901',
      notes: 'Egen anteckning',
    }, registerRow)).toEqual({
      address_line1: 'Storgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
    })
  })

  it('fills the address only on a card with no part of one', () => {
    expect(buildCustomerMetadataEnrichment({ ...stubDetails, city: 'Uppsala' }, registerRow))
      .not.toHaveProperty('address_line1')
    expect(buildCustomerMetadataEnrichment({ ...stubDetails, city: 'Uppsala' }, registerRow))
      .not.toHaveProperty('city')
  })

  it('leaves a column the caller did not read alone', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    }, registerRow)).toBeNull()
  })

  it('does not turn a blank provider value into a filled column', () => {
    expect(buildCustomerMetadataEnrichment(stubDetails, { ...registerRow, phone: '  ', email: '',
      address_line1: null, postal_code: null, city: null, vat_number: null, notes: null })).toBeNull()
  })

  it('fills a supplier the same way, bank details included', () => {
    const stub = {
      org_number: null, email: null, phone: null, address_line1: null, address_line2: null,
      postal_code: null, city: null, country: 'SE', vat_number: null, bankgiro: null, plusgiro: null,
      bank_account: null, notes: null,
    }
    expect(buildSupplierEnrichment(stub, {
      org_number: '5566778899', email: 'order@lev.example', phone: '031-12 34 56', address_line1: 'Hamngatan 2',
      postal_code: '411 06', city: 'Göteborg', country: 'SE', bankgiro: '123-4567', plusgiro: null, bank_account: null,
    })).toEqual({
      org_number: '5566778899', email: 'order@lev.example', phone: '031-12 34 56', address_line1: 'Hamngatan 2',
      postal_code: '411 06', city: 'Göteborg', bankgiro: '123-4567',
    })
    expect(buildSupplierEnrichment({ ...stub, phone: '031-00 00 00', bankgiro: '765-4321', org_number: undefined },
      { phone: '031-12 34 56', bankgiro: '123-4567', org_number: '5566778899' })).toBeNull()
  })

  it('fills a supplier\'s default account on a card that has none, never over one (crm#1744)', () => {
    expect(buildSupplierEnrichment({ default_expense_account: null }, { default_expense_account: '5410' }))
      .toEqual({ default_expense_account: '5410' })
    expect(buildSupplierEnrichment({ default_expense_account: '6110' }, { default_expense_account: '5410' })).toBeNull()
    expect(buildSupplierEnrichment({ default_expense_account: null }, { default_expense_account: null })).toBeNull()
  })

  describe('a supplier\'s bank account', () => {
    const card = {
      bankgiro: null, plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null, bic: null,
    }
    const row = { clearing_number: '8327-9', account_number: '123 456 789-0', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' }

    it('fills the clearing and account number, the IBAN and the BIC on a card that has none', () => {
      expect(buildSupplierEnrichment(card, row)).toEqual(row)
    })

    it('fills the account on the card an earlier import gave the same account without its clearing number', () => {
      expect(buildSupplierEnrichment({ ...card, bank_account: '123456789-0' }, row))
        .toMatchObject({ clearing_number: '8327-9', account_number: '123 456 789-0' })
      expect(buildSupplierEnrichment({ ...card, bank_account: '8327-9, 123 456 789-0' }, row))
        .toMatchObject({ clearing_number: '8327-9', account_number: '123 456 789-0' })
    })

    it('never pairs the provider\'s account with a clearing number or another account on the card', () => {
      expect(buildSupplierEnrichment({ ...card, clearing_number: '6000' }, row)).not.toHaveProperty('account_number')
      expect(buildSupplierEnrichment({ ...card, bank_account: '5000-1112223' }, row)).not.toHaveProperty('account_number')
    })
  })
})

describe('writing an enrichment', () => {
  it('writes only while every filled column is still empty', async () => {
    const { supabase, calls, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'cust-1' } })
    const result = await writeCustomerEnrichment(supabase as unknown as SupabaseClient, 'company-1', 'cust-1',
      { phone: '08-123 45 67', city: 'Stockholm' })
    expect(result).toEqual({ data: { id: 'cust-1' }, error: null })
    const update = calls.find((c) => c.method === 'update')!
    expect(update.args[0]).toMatchObject({ phone: '08-123 45 67', city: 'Stockholm', email: undefined })
    const guarded = calls.filter((c) => c.method === 'is').map((c) => c.args[0])
    expect(guarded).toEqual(['phone', 'address_line1', 'address_line2', 'postal_code', 'city'])
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['id', 'cust-1'], ['company_id', 'company-1']])
  })

  it('writes a customer number or a default account only while the card has none (crm#1744)', async () => {
    const customer = createQueuedMockSupabase()
    customer.enqueue({ data: { id: 'cust-1' } })
    await writeCustomerEnrichment(customer.supabase as unknown as SupabaseClient, 'company-1', 'cust-1', { customer_number: '1001' })
    expect(customer.calls.find((c) => c.method === 'update')?.args[0]).toMatchObject({ customer_number: '1001' })
    expect(customer.calls.filter((c) => c.method === 'is').map((c) => c.args[0])).toEqual(['customer_number'])

    const supplier = createQueuedMockSupabase()
    supplier.enqueue({ data: { id: 'sup-1' } })
    await writeSupplierEnrichment(supplier.supabase as unknown as SupabaseClient, 'company-1', 'sup-1', { default_expense_account: '5410' })
    expect(supplier.calls.find((c) => c.method === 'update')?.args[0]).toMatchObject({ default_expense_account: '5410' })
    expect(supplier.calls.filter((c) => c.method === 'is').map((c) => c.args[0])).toEqual(['default_expense_account'])
  })

  it('answers no row when the card got a value in between', async () => {
    const { supabase, calls, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await writeSupplierEnrichment(supabase as unknown as SupabaseClient, 'company-1', 'sup-1',
      { phone: '031-12 34 56', bankgiro: '123-4567' })
    expect(result).toEqual({ data: null, error: null })
    expect(calls.find((c) => c.method === 'update')?.table).toBe('suppliers')
    expect(calls.filter((c) => c.method === 'is').map((c) => c.args[0])).toEqual(['phone', 'bankgiro'])
  })

  it('writes a bank account only while the card has neither a clearing nor an account number', async () => {
    const { supabase, calls, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sup-1' } })
    await writeSupplierEnrichment(supabase as unknown as SupabaseClient, 'company-1', 'sup-1',
      { clearing_number: '8327-9', account_number: '123 456 789-0', iban: 'DE89370400440532013000' })
    expect(calls.find((c) => c.method === 'update')?.args[0])
      .toMatchObject({ clearing_number: '8327-9', account_number: '123 456 789-0', iban: 'DE89370400440532013000' })
    expect(calls.filter((c) => c.method === 'is').map((c) => c.args[0])).toEqual(['clearing_number', 'account_number', 'iban'])
  })
})
