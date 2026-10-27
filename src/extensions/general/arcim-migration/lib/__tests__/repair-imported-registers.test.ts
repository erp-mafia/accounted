import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CustomerDto, SupplierDto } from '@/lib/providers/dto'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { mapVismaToCustomer } from '@/lib/providers/visma/mapper'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  applyRegisterRepairs,
  customerRepair,
  matchRecords,
  planRegisterRepair,
  runRegisterRepair,
  sourceRecord,
  supplierRepair,
  type CustomerRow,
  type SupplierRow,
} from '../repair-imported-registers'

/**
 * crm#1436: the one-off repair of the cards older imports wrote. Each card
 * gets what the import writes today from its provider's record, only where it
 * is still empty or still holds the old import's value, and a sole trader
 * whose org number is a personnummer stays a company: the provider's own type
 * decides, never the number.
 */

const NOW = '2026-10-27T08:00:00.000Z'

beforeEach(() => { vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'register-repair-test-only') })
afterEach(() => { vi.unstubAllEnvs() })

const customerRow = (extra: Partial<CustomerRow> = {}): CustomerRow => ({
  id: 'c1', name: 'Anna Andersson', customer_number: '1', customer_type: 'swedish_business', org_number: '19121212-1212',
  personal_number: null, vat_number: null, contact_person: null, invoice_email_cc_addresses: null,
  invoice_email_bcc_addresses: null, email: null, phone: null, address_line1: null, address_line2: null, postal_code: null,
  city: null, country: null, notes: null, default_payment_terms: 30, ...extra,
})

const supplierRow = (extra: Partial<SupplierRow> = {}): SupplierRow => ({
  id: 's1', name: 'Lieferant GmbH', supplier_type: 'swedish_business', org_number: null, vat_number: null, email: null,
  phone: null, address_line1: null, address_line2: null, postal_code: null, city: null, country: null, bankgiro: null,
  plusgiro: null, bank_account: null, clearing_number: null, account_number: null, iban: null, bic: null, notes: null,
  default_payment_terms: 30, default_currency: 'SEK', ...extra,
})

const fortnoxCustomer = (extra: Record<string, unknown> = {}) =>
  mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Anna Andersson', OrganisationNumber: '19121212-1212', Active: true, ...extra })

describe('customerRepair', () => {
  it('makes the private person Fortnox names a private customer, the personnummer encrypted and no org number', () => {
    const repair = customerRepair(customerRow(), fortnoxCustomer({ Type: 'PRIVATE', Phone1: '070-123 45 67', CountryCode: 'SE' }), false, NOW)!
    expect(repair.kinds).toEqual(expect.arrayContaining(['private', 'filled']))
    expect(repair.correct).toMatchObject({ customer_type: 'individual', org_number: null })
    expect(revealStoredCustomerPersonalNumber(repair.correct.personal_number as string)).toBe('19121212-1212')
    expect(repair.guard).toEqual({ customer_type: 'swedish_business', org_number: '19121212-1212', personal_number: null })
    // The revert reads the personnummer back from the card; it is never kept twice.
    expect(JSON.stringify(repair.was)).not.toContain('1212')
    expect(repair.fill).toMatchObject({ phone: '070-123 45 67', country: 'SE' })
  })

  it('leaves a sole trader a company: Fortnox calls it one, whatever its number looks like', () => {
    expect(customerRepair(customerRow(), fortnoxCustomer({ Type: 'COMPANY' }), false, NOW)?.kinds ?? []).not.toContain('private')
  })

  it('never re-types a card someone gave a real org number or a personal number', () => {
    expect(customerRepair(customerRow({ org_number: '556677-8899' }), fortnoxCustomer({ Type: 'PRIVATE' }), false, NOW)?.kinds ?? [])
      .not.toContain('private')
    expect(customerRepair(customerRow({ personal_number: 'sealed' }), fortnoxCustomer({ Type: 'PRIVATE' }), false, NOW)?.kinds ?? [])
      .not.toContain('private')
  })

  it('makes a Swedish card without a country the EU business its record names, with the terms Fortnox states', () => {
    const repair = customerRepair(customerRow({ name: 'Kunde GmbH', org_number: null }),
      fortnoxCustomer({ Name: 'Kunde GmbH', Type: 'COMPANY', OrganisationNumber: '', CountryCode: 'DE', VATNumber: 'DE123456788', TermsOfPayment: '10' }),
      false, NOW)!
    expect(repair.correct).toEqual({ customer_type: 'eu_business', default_payment_terms: 10 })
    expect(repair.guard).toEqual({ customer_type: 'swedish_business', default_payment_terms: 30 })
    expect(repair.fill).toMatchObject({ country: 'DE', vat_number: 'DE123456788' })
  })

  it('archives only a card the import made from a record marked inactive', () => {
    expect(customerRepair(customerRow(), fortnoxCustomer({ Type: 'COMPANY', Active: false }), true, NOW)?.correct)
      .toMatchObject({ archived_at: NOW })
    expect(customerRepair(customerRow(), fortnoxCustomer({ Type: 'COMPANY', Active: false }), false, NOW)?.kinds ?? [])
      .not.toContain('archived')
  })

  it('answers nothing for a card that is already right', () => {
    const card = customerRow({ customer_type: 'individual', org_number: null, personal_number: 'sealed', country: 'SE', phone: '070-1' })
    expect(customerRepair(card, fortnoxCustomer({ Type: 'PRIVATE', CountryCode: 'SE', Phone1: '070-1' }), false, NOW)).toBeNull()
  })

  it('reads Visma\'s private flag the same way', () => {
    const dto = mapVismaToCustomer({ Id: 'v-1', CustomerNumber: '1', Name: 'Anna Andersson', IsPrivatePerson: true, IsActive: true,
      CorporateIdentityNumber: '19121212-1212' })
    expect(customerRepair(customerRow(), dto, false, NOW)?.kinds).toContain('private')
  })
})

describe('supplierRepair', () => {
  it('gives a foreign supplier its country, VAT number, IBAN and BIC, its EU type and its currency', () => {
    const repair = supplierRepair(supplierRow(), mapFortnoxToSupplier({
      SupplierNumber: '7', Name: 'Lieferant GmbH', Active: true, CountryCode: 'DE', VATNumber: 'DE812345673',
      IBAN: 'DE89370400440532013000', BIC: 'COBADEFFXXX', Currency: 'EUR',
    }), false, NOW)!
    expect(repair.fill).toMatchObject({ country: 'DE', vat_number: 'DE812345673', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' })
    expect(repair.correct).toEqual({ supplier_type: 'eu_business', default_currency: 'EUR' })
    expect(repair.guard).toEqual({ supplier_type: 'swedish_business', default_currency: 'SEK' })
  })

  it('never replaces a currency or type someone set', () => {
    const repair = supplierRepair(supplierRow({ supplier_type: 'non_eu_business', country: 'DE', default_currency: 'USD' }),
      mapFortnoxToSupplier({ SupplierNumber: '7', Name: 'Lieferant GmbH', Active: true, CountryCode: 'DE', Currency: 'EUR' }), false, NOW)
    expect(repair?.correct ?? {}).toEqual({})
  })
})

describe('matchRecords', () => {
  const record = (number: string, extra: Record<string, unknown> = {}) =>
    sourceRecord('fortnox', 'customers', fortnoxCustomer({ CustomerNumber: number, Name: `Kund ${number}`, OrganisationNumber: '', ...extra }))!

  it('finds the card through the source map, else by identity, and never looks for an inactive record the import left out', () => {
    const matches = matchRecords(
      [record('1'), record('2', { OrganisationNumber: '556677-8899' }), record('3', { Active: false, Name: 'Anna' })],
      { customers: [
        { id: 'c1', identities: [] },
        { id: 'c2', identities: ['5566778899'] },
        { id: 'c3', identities: [], name: 'anna' },
      ], suppliers: [] },
      new Map([['customers:1', ['c1']]]),
    )
    expect(matches.map((m) => [m.key, m.cardId, m.sourceMapped])).toEqual([['customers:1', 'c1', true], ['customers:2', 'c2', false]])
  })
})

describe('planRegisterRepair', () => {
  const tables = () => createTableMockSupabase({
    provider_consents: { data: [{ id: 'consent-1' }] },
    customers: { data: [customerRow()] },
    suppliers: { data: [] },
    migration_source_records: { data: [{ resource: 'customers', source_id: '1', target_id: 'c1' }] },
  })

  it('reads Fortnox\'s own record for every matched card and plans the repair from it', async () => {
    const { supabase } = tables()
    const listed = fortnoxCustomer()
    const hydrateCustomers = vi.fn(async (_p: unknown, _t: unknown, _c: unknown, dtos: CustomerDto[]) => ({
      customers: dtos.map(() => fortnoxCustomer({ Type: 'PRIVATE' })), unhydratedIds: new Set<string>(),
      hydration: { needed: dtos.length, hydrated: dtos.length, failed: 0, skippedForBudget: 0 },
    }))
    const plan = await planRegisterRepair(supabase as unknown as SupabaseClient, 'company-1', 'fortnox',
      { from: null, deadline: Date.now() + 60_000, now: NOW }, {
        resolveConsent: vi.fn().mockResolvedValue({ accessToken: 'token', consent: {} }),
        fetchMigrationPage: vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string) =>
          ({ items: resource === 'customers' ? [listed] : [], nextPage: null, total: 1 })) as never,
        hydrateCustomers: hydrateCustomers as never,
        hydrateSuppliers: vi.fn() as never,
      })
    expect(hydrateCustomers).toHaveBeenCalledOnce()
    expect(plan.state).toBe('fetched')
    expect(plan.repairs.map((r) => [r.id, r.kinds.includes('private')])).toEqual([['c1', true]])
  })

  it('plans nothing for a company whose connection is gone', async () => {
    const { supabase } = createTableMockSupabase({ provider_consents: { data: [] } })
    const plan = await planRegisterRepair(supabase as unknown as SupabaseClient, 'company-1', 'visma',
      { from: null, deadline: Date.now() + 60_000 })
    expect(plan).toEqual({ state: 'no_consent', repairs: [], next: null })
  })
})

describe('applyRegisterRepairs', () => {
  it('writes each correction only while the card still holds what it was decided on, and never archives an invoiced card', async () => {
    const { supabase, calls } = createTableMockSupabase({
      customers: { data: [{ id: 'c1' }] },
      invoices: { data: [{ party: 'c2' }] },
    })
    const repairs = [
      customerRepair(customerRow(), fortnoxCustomer({ Type: 'PRIVATE' }), false, NOW)!,
      customerRepair(customerRow({ id: 'c2', org_number: '556677-8899' }), fortnoxCustomer({ Type: 'COMPANY', Active: false }), true, NOW)!,
    ]
    const changed = await applyRegisterRepairs(supabase as unknown as SupabaseClient, 'company-1', repairs, { concurrency: 1 })
    const guards = calls.filter((c) => c.table === 'customers' && (c.method === 'eq' || c.method === 'is')).map((c) => c.args)
    expect(guards).toEqual(expect.arrayContaining([
      ['customer_type', 'swedish_business'], ['org_number', '19121212-1212'], ['personal_number', null],
    ]))
    const updates = calls.filter((c) => c.table === 'customers' && c.method === 'update').map((c) => c.args[0] as Record<string, unknown>)
    expect(updates.some((u) => 'archived_at' in u)).toBe(false)
    expect(changed.map((c) => [c.id, c.kinds])).toEqual([['c1', ['private']]])
  })
})

describe('the suppliers a card dto names', () => {
  it('builds a source record for a supplier with its keys', () => {
    const record = sourceRecord('fortnox', 'suppliers', mapFortnoxToSupplier({ SupplierNumber: '7', Name: 'Leverantör AB',
      OrganisationNumber: '556677-8899', Active: true }) as SupplierDto)
    expect(record?.facts).toMatchObject({ identity: '5566778899', name: 'leverantör ab' })
  })
})

describe('runRegisterRepair', () => {
  const run = async (hydrated: CustomerDto) => {
    const mock = createTableMockSupabase({
      provider_consents: (chain) => chain[0]?.args[0] === 'company_id, provider'
        ? { data: [{ company_id: 'company-1', provider: 'fortnox' }] }
        : { data: [{ id: 'consent-1' }] },
      register_repair_progress: (chain) => {
        if (chain[0]?.method !== 'select') return { data: null }
        return chain[0].args[0] === 'changed'
          ? { data: { changed: [{ resource: 'customers', id: 'c0', kinds: ['terms'] }] } }
          : { data: [{ company_id: 'company-1', provider: 'fortnox', next_key: null, outcome: null, attempts: 1, counts: { terms: 1 } }] }
      },
      companies: { data: { archived_at: null } },
      company_migration_resets: { data: [] },
      customers: { data: [customerRow()] },
      suppliers: { data: [] },
      migration_source_records: { data: [{ resource: 'customers', source_id: '1', target_id: 'c1' }] },
      invoices: { data: [] },
    })
    const summary = await runRegisterRepair(mock.supabase as unknown as SupabaseClient, Date.now() + 120_000, {
      resolveConsent: vi.fn().mockResolvedValue({ accessToken: 'token', consent: {} }),
      fetchMigrationPage: vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string) =>
        ({ items: resource === 'customers' ? [fortnoxCustomer()] : [], nextPage: null, total: 1 })) as never,
      hydrateCustomers: vi.fn(async (_p: unknown, _t: unknown, _c: unknown, dtos: CustomerDto[]) => ({
        customers: dtos.map(() => hydrated), unhydratedIds: new Set<string>(),
        hydration: { needed: dtos.length, hydrated: dtos.length, failed: 0, skippedForBudget: 0 },
      })) as never,
      hydrateSuppliers: vi.fn() as never,
    })
    return { summary, ...mock }
  }

  it('records the outcome, then appends the cards it changed to the trail the earlier runs left', async () => {
    const { summary, payloads } = await run(fortnoxCustomer({ Type: 'PRIVATE' }))
    expect(summary).toEqual({ pending: 1, worked: 1, finished: 1, changed: 1 })
    const [progress] = payloads('register_repair_progress', 'upsert') as Record<string, unknown>[]
    expect(progress).toMatchObject({ company_id: 'company-1', provider: 'fortnox', outcome: 'done', attempts: 1, counts: { terms: 1, private: 1 } })
    expect(progress).not.toHaveProperty('changed')
    const appended = payloads('register_repair_progress', 'update') as { changed: { id: string; kinds: string[] }[] }[]
    expect(appended.map((u) => u.changed.map((c) => [c.id, c.kinds]))).toEqual([[['c0', ['terms']], ['c1', ['private']]]])
  })

  it('leaves the trail alone when a run changed nothing', async () => {
    const { summary, payloads } = await run(fortnoxCustomer())
    expect(summary.changed).toBe(0)
    expect(payloads('register_repair_progress', 'upsert')).toHaveLength(1)
    expect(payloads('register_repair_progress', 'update')).toEqual([])
  })
})
