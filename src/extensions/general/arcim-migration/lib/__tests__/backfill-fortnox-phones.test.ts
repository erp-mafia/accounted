import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import {
  applyPhoneFills,
  phoneSourceRecord,
  planFortnoxPhoneBackfill,
  planPhoneFills,
  type PhoneCard,
} from '../backfill-fortnox-phones'

/**
 * crm#1436: the backfill behind fortnox-phone-backfill-routes. It reads the
 * phone from the raw Fortnox fields with today's mapper, finds each card by
 * the import's source map or else by identity, fills only a NULL phone, and
 * takes Fortnox today over a stored payload.
 */

const COMPANY = 'company-1'

const customer = (number: string, extra: Record<string, unknown> = {}) =>
  ({ CustomerNumber: number, Name: `Kund ${number}`, Active: true, ...extra })
const supplier = (number: string, extra: Record<string, unknown> = {}) =>
  ({ SupplierNumber: number, Name: `Leverantör ${number}`, Active: true, ...extra })

const record = (raw: Record<string, unknown>) => phoneSourceRecord('customers', raw)!
const card = (id: string, phone: string | null, keys: Partial<PhoneCard['card']> = {}): PhoneCard =>
  ({ phone, card: { id, identities: [], ...keys } })
const cards = (customers: PhoneCard[], suppliers: PhoneCard[] = []) => ({ customers, suppliers })

describe('phoneSourceRecord', () => {
  it('reads the list form Phone that a stored payload of the old mapper dropped', () => {
    expect(phoneSourceRecord('customers', customer('1', { Phone: '08-1' }))).toMatchObject({
      resource: 'customers', sourceId: '1', active: true, phone: '08-1', facts: { number: '1', name: 'kund 1' },
    })
    expect(phoneSourceRecord('suppliers', supplier('7', { Phone: '08-7', OrganisationNumber: '556677-8899' })))
      .toMatchObject({ resource: 'suppliers', sourceId: '7', phone: '08-7', facts: { identity: '5566778899' } })
  })

  it('has no record without a source number', () => {
    expect(phoneSourceRecord('customers', { Name: 'Utan nummer', Phone: '08-1' })).toBeNull()
  })
})

describe('planPhoneFills', () => {
  it('fills a NULL phone on the card the source map names', () => {
    const plan = planPhoneFills([record(customer('1', { Phone: '08-1' }))], cards([card('c1', null)]),
      new Map([['customers:1', ['c1']]]))
    expect(plan.fills).toEqual([{ resource: 'customers', id: 'c1', phone: '08-1' }])
    expect(plan.counts.customers).toEqual({ fill: 1 })
  })

  it('never touches a phone the card has, an empty string (a cleared number) included', () => {
    const plan = planPhoneFills(
      [record(customer('1', { Phone: '08-1' })), record(customer('2', { Phone: '08-2' }))],
      cards([card('c1', '070-9'), card('c2', '')]),
      new Map([['customers:1', ['c1']], ['customers:2', ['c2']]]))
    expect(plan.fills).toEqual([])
    expect(plan.counts.customers).toEqual({ has_phone: 2 })
  })

  it('finds a card the older import left unmapped by its org number, then its name', () => {
    const plan = planPhoneFills(
      [
        record(customer('1', { Phone: '08-1', OrganisationNumber: '556677-8899' })),
        record(customer('2', { Phone: '08-2', Name: 'Anna Andersson' })),
      ],
      cards([
        card('c1', null, { identities: ['5566778899'], name: 'annat namn' }),
        card('c2', null, { name: 'anna andersson' }),
        card('c3', null, { name: 'någon annan' }),
      ]),
      new Map())
    expect(plan.fills).toEqual([
      { resource: 'customers', id: 'c1', phone: '08-1' },
      { resource: 'customers', id: 'c2', phone: '08-2' },
    ])
  })

  it('does not guess between two cards with the same name', () => {
    const plan = planPhoneFills([record(customer('1', { Phone: '08-1', Name: 'Anna' }))],
      cards([card('c1', null, { name: 'anna' }), card('c2', null, { name: 'anna' })]), new Map())
    expect(plan.fills).toEqual([])
    expect(plan.counts.customers).toEqual({ no_card: 1 })
  })

  it('never name-matches a card another source record maps to', () => {
    const plan = planPhoneFills([record(customer('2', { Phone: '08-2', Name: 'Anna' }))],
      cards([card('c1', null, { name: 'anna' })]), new Map([['customers:1', ['c1']]]))
    expect(plan.fills).toEqual([])
  })

  it('skips an inactive record the import never brought over, and one without a phone', () => {
    const plan = planPhoneFills(
      [record(customer('1', { Phone: '08-1', Active: false, Name: 'Anna' })), record(customer('2', { Name: 'Bo' }))],
      cards([card('c1', null, { name: 'anna' }), card('c2', null, { name: 'bo' })]), new Map())
    expect(plan.fills).toEqual([])
    expect(plan.counts.customers).toEqual({ inactive: 1, no_phone: 1 })
  })

  it('leaves a card alone when two records name it with different numbers', () => {
    const plan = planPhoneFills(
      [
        record(customer('1', { Phone: '08-1', OrganisationNumber: '556677-8899' })),
        record(customer('2', { Phone: '08-2', OrganisationNumber: '556677-8899' })),
      ],
      cards([card('c1', null, { identities: ['5566778899'] })]), new Map())
    expect(plan.fills).toEqual([])
    expect(plan.counts.customers).toEqual({ conflict: 1 })
  })

  it('keeps customers and suppliers apart', () => {
    const plan = planPhoneFills(
      [phoneSourceRecord('suppliers', supplier('1', { Phone: '08-7' }))!],
      cards([card('c1', null)], [card('s1', null)]),
      new Map([['customers:1', ['c1']], ['suppliers:1', ['s1']]]))
    expect(plan.fills).toEqual([{ resource: 'suppliers', id: 's1', phone: '08-7' }])
  })

  it('reports a card the source map names but that is gone or archived', () => {
    const plan = planPhoneFills([record(customer('1', { Phone: '08-1' }))], cards([]),
      new Map([['customers:1', ['c-archived']]]))
    expect(plan.counts.customers).toEqual({ no_card: 1 })
  })
})

const openJson = <T,>(payload: string) => JSON.parse(payload) as T

/** A company's tables as the planner reads them. */
function companyTables(params: {
  chunks?: { resource: string; payload: unknown }[]
  consents?: string[]
  customers?: Record<string, unknown>[]
  suppliers?: Record<string, unknown>[]
  sourceMap?: { resource: string; source_id: string; target_id: string }[]
}) {
  return {
    migration_jobs: { data: params.chunks ? [{ id: 'job-1' }] : [] },
    migration_job_chunks: {
      data: (params.chunks ?? []).map((c) => ({ resource: c.resource, payload: JSON.stringify(c.payload) })),
    },
    provider_consents: { data: (params.consents ?? []).map((id) => ({ id })) },
    customers: { data: params.customers ?? [] },
    suppliers: { data: params.suppliers ?? [] },
    migration_source_records: { data: params.sourceMap ?? [] },
  }
}

const customerRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: null, org_number: null, personal_number: null, vat_number: null, customer_number: null, phone: null, ...extra,
})

describe('planFortnoxPhoneBackfill', () => {
  it('reads stored payloads with the newest import winning, without asking Fortnox when told not to', async () => {
    const { supabase } = createTableMockSupabase(companyTables({
      chunks: [
        { resource: 'customers', payload: mapFortnoxToCustomer(customer('1', { Phone: '08-old' })) },
        { resource: 'customers', payload: mapFortnoxToCustomer(customer('1', { Phone: '08-new' })) },
        { resource: 'suppliers', payload: mapFortnoxToSupplier(supplier('9', { Phone: '08-9' })) },
        { resource: 'customers', payload: { id: '5', migrationError: 'MIGRATION_INVOICE_TOO_LARGE' } },
        { resource: 'customers', payload: { id: '6' } },
      ],
      customers: [customerRow('c1')],
      suppliers: [{ id: 's9', name: null, org_number: null, vat_number: null, phone: null }],
      sourceMap: [
        { resource: 'customers', source_id: '1', target_id: 'c1' },
        { resource: 'suppliers', source_id: '9', target_id: 's9' },
      ],
    }))
    const resolve = vi.fn()
    const plan = await planFortnoxPhoneBackfill(supabase as unknown as SupabaseClient, COMPANY,
      { fetchFromFortnox: false }, { openPayload: openJson, resolveConsent: resolve })
    expect(resolve).not.toHaveBeenCalled()
    expect(plan).toMatchObject({ stored: 3, fetched: 0, unreadable: 1, fortnox: 'skipped' })
    expect(plan.fills).toEqual([
      { resource: 'customers', id: 'c1', phone: '08-new' },
      { resource: 'suppliers', id: 's9', phone: '08-9' },
    ])
  })

  it('fetches both lists from Fortnox for a company the older import stored nothing for', async () => {
    const { supabase } = createTableMockSupabase(companyTables({
      consents: ['consent-1'],
      customers: [customerRow('c1', { name: 'Kund 1', org_number: '556677-8899' })],
    }))
    const fetchPage = vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string, page: number) => {
      if (resource === 'customers' && page === 1) {
        return { items: [mapFortnoxToCustomer(customer('1', { Phone: '08-1', OrganisationNumber: '5566778899' }))], nextPage: 2, total: 2 }
      }
      if (resource === 'customers') return { items: [mapFortnoxToCustomer(customer('2'))], nextPage: null, total: 2 }
      return { items: [mapFortnoxToSupplier(supplier('1', { Phone: '08-7' }))], nextPage: null, total: 1 }
    })
    const plan = await planFortnoxPhoneBackfill(supabase as unknown as SupabaseClient, COMPANY, { fetchFromFortnox: true },
      {
        openPayload: openJson,
        resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 'token' }),
        fetchMigrationPage: fetchPage as never,
      })
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(plan).toMatchObject({ stored: 0, fetched: 3, fortnox: 'fetched' })
    expect(plan.fills).toEqual([{ resource: 'customers', id: 'c1', phone: '08-1' }])
    expect(plan.counts).toEqual({ customers: { fill: 1, no_phone: 1 }, suppliers: { no_card: 1 } })
  })

  it('takes Fortnox today over a stored payload', async () => {
    const { supabase } = createTableMockSupabase(companyTables({
      chunks: [{ resource: 'customers', payload: mapFortnoxToCustomer(customer('1', { Phone: '08-stored' })) }],
      consents: ['consent-1'],
      customers: [customerRow('c1')],
      sourceMap: [{ resource: 'customers', source_id: '1', target_id: 'c1' }],
    }))
    const fetchPage = vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string) => ({
      items: resource === 'customers' ? [mapFortnoxToCustomer(customer('1', { Phone: '08-today' }))] : [],
      nextPage: null, total: 1,
    }))
    const plan = await planFortnoxPhoneBackfill(supabase as unknown as SupabaseClient, COMPANY, { fetchFromFortnox: true },
      { openPayload: openJson, resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 't' }), fetchMigrationPage: fetchPage as never })
    expect(plan.fills).toEqual([{ resource: 'customers', id: 'c1', phone: '08-today' }])
  })

  it('reports a company without a Fortnox connection, and an expired one, and still uses what is stored', async () => {
    const tables = companyTables({
      chunks: [{ resource: 'customers', payload: mapFortnoxToCustomer(customer('1', { Phone: '08-1' })) }],
      customers: [customerRow('c1')],
      sourceMap: [{ resource: 'customers', source_id: '1', target_id: 'c1' }],
    })
    const none = await planFortnoxPhoneBackfill(createTableMockSupabase(tables).supabase as unknown as SupabaseClient,
      COMPANY, { fetchFromFortnox: true }, { openPayload: openJson })
    expect(none).toMatchObject({ fortnox: 'no_consent', fills: [{ id: 'c1', phone: '08-1' }] })

    const expired = await planFortnoxPhoneBackfill(
      createTableMockSupabase({ ...tables, provider_consents: { data: [{ id: 'consent-1' }] } }).supabase as unknown as SupabaseClient,
      COMPANY, { fetchFromFortnox: true },
      { openPayload: openJson, resolveConsent: vi.fn().mockRejectedValue({ status: 401, message: 'Token expired' }) })
    expect(expired).toMatchObject({ fortnox: 'consent_expired', fortnoxError: 'Token expired', fills: [{ id: 'c1' }] })
  })

  it('reads only archived-free cards and only Fortnox source records', async () => {
    const mock = createTableMockSupabase(companyTables({}))
    await planFortnoxPhoneBackfill(mock.supabase as unknown as SupabaseClient, COMPANY, { fetchFromFortnox: false })
    expect(mock.findCall('customers', 'is')).toEqual(['archived_at', null])
    expect(mock.findCall('suppliers', 'is')).toEqual(['archived_at', null])
    expect(mock.findCall('migration_source_records', 'eq')).toEqual(['company_id', COMPANY])
    expect(mock.findCalls('migration_source_records', 'eq')).toContainEqual(['provider', 'fortnox'])
  })
})

describe('applyPhoneFills', () => {
  const fills = [
    { resource: 'customers' as const, id: 'c1', phone: '08-1' },
    { resource: 'suppliers' as const, id: 's1', phone: '08-2' },
  ]

  it('writes each phone only while the card has none', async () => {
    const answered: TableMockResolver = (calls) =>
      ({ data: calls.some((c) => c.method === 'eq' && c.args[1] === 'c1') ? [{ id: 'c1' }] : [] })
    const mock = createTableMockSupabase({ customers: answered, suppliers: answered })
    const result = await applyPhoneFills(mock.supabase as unknown as SupabaseClient, COMPANY, fills,
      { deadline: Date.now() + 60_000 })
    expect(result).toEqual({ filled: 1, changed: 1, remaining: 0 })
    expect(mock.payloads('customers', 'update')).toEqual([{ phone: '08-1' }])
    expect(mock.findCalls('customers', 'eq')).toEqual([['id', 'c1'], ['company_id', COMPANY]])
    expect(mock.findCall('customers', 'is')).toEqual(['phone', null])
  })

  it('stops at the deadline and reports what is left', async () => {
    const mock = createTableMockSupabase()
    const result = await applyPhoneFills(mock.supabase as unknown as SupabaseClient, COMPANY, fills,
      { deadline: Date.now() - 1 })
    expect(result).toEqual({ filled: 0, changed: 0, remaining: 2 })
    expect(mock.tables()).toEqual([])
  })

  it('raises a write error', async () => {
    const mock = createTableMockSupabase({ customers: { error: { message: 'boom' } } })
    await expect(applyPhoneFills(mock.supabase as unknown as SupabaseClient, COMPANY, fills.slice(0, 1),
      { deadline: Date.now() + 60_000 })).rejects.toThrow('customers: boom')
  })
})
