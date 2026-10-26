import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CustomerDto, SupplierDto } from '@/lib/providers/dto'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

type ChainCalls = { method: string; args: unknown[] }[]
const eqArg = (calls: ChainCalls, column: string) =>
  calls.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]
import {
  applyTermsFills,
  matchTermsCandidates,
  planFortnoxTermsBackfill,
  readCandidateTerms,
  runFortnoxTermsBackfill,
  statedTerms,
  termsSourceRecord,
  type TermsCard,
} from '../backfill-fortnox-terms'

/**
 * crm#1245: the backfill behind fortnox-terms-backfill-routes. It finds each
 * card a Fortnox record names (source map, else identity), takes only cards
 * still on the import's 30-day default, reads Fortnox's detail form for the
 * real terms, and writes only while the card is still on 30.
 */

const COMPANY = 'company-1'

const customer = (number: string, extra: Record<string, unknown> = {}) =>
  ({ CustomerNumber: number, Name: `Kund ${number}`, Active: true, ...extra })
const supplier = (number: string, extra: Record<string, unknown> = {}) =>
  ({ SupplierNumber: number, Name: `Leverantör ${number}`, Active: true, ...extra })

const listed = (number: string, extra: Record<string, unknown> = {}) => mapFortnoxToCustomer(customer(number, extra))
const record = (number: string, extra: Record<string, unknown> = {}) => termsSourceRecord('customers', listed(number, extra))!
const card = (id: string, terms: number | null, keys: Partial<TermsCard['card']> = {}): TermsCard =>
  ({ terms, card: { id, identities: [], ...keys } })
const cards = (customers: TermsCard[], suppliers: TermsCard[] = []) => ({ customers, suppliers })

/** A hydration double: the detail form of each listed record carries the terms in `terms`. */
function hydrator(terms: Record<string, string | undefined>, options: { fail?: string[]; abortedBy?: 'auth' | 'budget' } = {}) {
  const detail = (dto: CustomerDto | SupplierDto, kind: 'customers' | 'suppliers') => {
    const raw = { ...(dto._raw ?? {}), TermsOfPayment: terms[`${kind}:${dto.id}`] }
    return kind === 'customers' ? mapFortnoxToCustomer(raw) : mapFortnoxToSupplier(raw)
  }
  const run = (kind: 'customers' | 'suppliers') => vi.fn(async (_p: unknown, _t: unknown, _c: unknown, dtos: (CustomerDto | SupplierDto)[]) => {
    const failed = new Set((options.fail ?? []).filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)))
    const items = dtos.map((dto) => (failed.has(dto.id) ? dto : detail(dto, kind)))
    const hydration = { needed: dtos.length, hydrated: dtos.length - failed.size, failed: failed.size, skippedForBudget: 0,
      ...(options.abortedBy ? { abortedBy: options.abortedBy } : {}) }
    const unhydratedIds = new Set(failed)
    return kind === 'customers'
      ? { customers: items, hydration, unhydratedIds, authError: options.abortedBy === 'auth' ? new Error('Token rejected') : undefined }
      : { suppliers: items, hydration, unhydratedIds }
  })
  return { hydrateCustomers: run('customers') as never, hydrateSuppliers: run('suppliers') as never }
}

describe('statedTerms', () => {
  it('keeps whole days 0-365, a stated 0 included, and nothing else', () => {
    expect(statedTerms(0)).toBe(0)
    expect(statedTerms(10)).toBe(10)
    expect(statedTerms(365)).toBe(365)
    expect(statedTerms(undefined)).toBeNull()
    expect(statedTerms(Number.NaN)).toBeNull()
    expect(statedTerms(400)).toBeNull()
    expect(statedTerms(7.5)).toBeNull()
  })
})

describe('matchTermsCandidates', () => {
  it('takes the card the source map names when it is still on 30', () => {
    const { candidates } = matchTermsCandidates([record('1')], cards([card('c1', 30)]), new Map([['customers:1', ['c1']]]))
    expect(candidates.map((c) => [c.key, c.cardId])).toEqual([['customers:1', 'c1']])
  })

  it('never takes a card whose terms are not the import default', () => {
    const { candidates, counts } = matchTermsCandidates(
      [record('1'), record('2')],
      cards([card('c1', 10), card('c2', 0)]),
      new Map([['customers:1', ['c1']], ['customers:2', ['c2']]]))
    expect(candidates).toEqual([])
    expect(counts.customers).toEqual({ has_terms: 2 })
  })

  it('finds a card the older import left unmapped by its org number, then its name, but never guesses', () => {
    const { candidates, counts } = matchTermsCandidates(
      [
        record('1', { OrganisationNumber: '556677-8899' }),
        record('2', { Name: 'Anna Andersson' }),
        record('3', { Name: 'Bo' }),
      ],
      cards([
        card('c1', 30, { identities: ['5566778899'], name: 'annat namn' }),
        card('c2', 30, { name: 'anna andersson' }),
        card('c3', 30, { name: 'bo' }),
        card('c4', 30, { name: 'bo' }),
      ]),
      new Map())
    expect(candidates.map((c) => c.cardId)).toEqual(['c1', 'c2'])
    expect(counts.customers).toEqual({ no_card: 1 })
  })

  it('skips an inactive record the import never brought over', () => {
    const { candidates, counts } = matchTermsCandidates([record('1', { Active: false, Name: 'Anna' })],
      cards([card('c1', 30, { name: 'anna' })]), new Map())
    expect(candidates).toEqual([])
    expect(counts.customers).toEqual({ inactive: 1 })
  })

  it('keeps customers and suppliers apart, customers first', () => {
    const { candidates } = matchTermsCandidates(
      [termsSourceRecord('suppliers', mapFortnoxToSupplier(supplier('1')))!, record('1')],
      cards([card('c1', 30)], [card('s1', 30)]),
      new Map([['customers:1', ['c1']], ['suppliers:1', ['s1']]]))
    expect(candidates.map((c) => c.key)).toEqual(['customers:1', 'suppliers:1'])
  })

  it('starts the candidates at `from`, yet still claims the earlier cards for the match', () => {
    const { candidates } = matchTermsCandidates(
      [record('1', { Name: 'Anna' }), record('2', { Name: 'Anna' })],
      cards([card('c1', 30, { name: 'anna' })]),
      new Map(),
      'customers:2')
    // Record 1 claims c1 by name, so record 2 cannot take it in the later run.
    expect(candidates).toEqual([])
  })
})

describe('readCandidateTerms', () => {
  const candidatesFor = (numbers: string[]) =>
    matchTermsCandidates(numbers.map((n) => record(n)), cards(numbers.map((n) => card(`c${n}`, 30))),
      new Map(numbers.map((n) => [`customers:${n}`, [`c${n}`]]))).candidates

  it('fills the terms Fortnox states, and counts 30, none and an unreadable code', async () => {
    const counts = { customers: {}, suppliers: {} }
    const result = await readCandidateTerms(candidatesFor(['1', '2', '3', '4', '5']), { accessToken: 't' },
      Date.now() + 60_000, counts, hydrator({ 'customers:1': '10', 'customers:2': '30', 'customers:3': undefined,
        'customers:4': 'K', 'customers:5': '0' }))
    expect(result).toEqual({
      fills: [{ resource: 'customers', id: 'c1', terms: 10 }, { resource: 'customers', id: 'c5', terms: 0 }],
      next: null,
    })
    expect(counts.customers).toEqual({ fill: 2, same: 1, no_terms: 2 })
  })

  it('counts a failed detail read and moves on', async () => {
    const counts = { customers: {}, suppliers: {} }
    const result = await readCandidateTerms(candidatesFor(['1', '2']), { accessToken: 't' }, Date.now() + 60_000, counts,
      hydrator({ 'customers:2': '15' }, { fail: ['customers:1'] }))
    expect(result.fills).toEqual([{ resource: 'customers', id: 'c2', terms: 15 }])
    expect(counts.customers).toEqual({ unread: 1, fill: 1 })
  })

  it('answers where to continue when the deadline cuts a batch, and writes nothing from it', async () => {
    const counts = { customers: {}, suppliers: {} }
    const result = await readCandidateTerms(candidatesFor(['1', '2']), { accessToken: 't' }, Date.now() + 60_000, counts,
      hydrator({ 'customers:1': '10' }, { abortedBy: 'budget' }))
    expect(result).toEqual({ fills: [], next: 'customers:1' })
  })

  it('answers where to continue when the deadline has passed before a batch', async () => {
    const counts = { customers: {}, suppliers: {} }
    const deps = hydrator({})
    const result = await readCandidateTerms(candidatesFor(['1']), { accessToken: 't' }, Date.now() - 1, counts, deps)
    expect(result).toEqual({ fills: [], next: 'customers:1' })
    expect(deps.hydrateCustomers).not.toHaveBeenCalled()
  })

  it('reads in batches of 50 and continues after the last finished one', async () => {
    const numbers = Array.from({ length: 120 }, (_, i) => String(1000 + i))
    const deps = hydrator(Object.fromEntries(numbers.map((n) => [`customers:${n}`, '10'])))
    let calls = 0
    const hydrateCustomers = vi.fn(async (...args: unknown[]) => {
      calls++
      const out = await (deps.hydrateCustomers as unknown as (...a: unknown[]) => Promise<{ hydration: object }>)(...args)
      return calls === 3 ? { ...out, hydration: { ...out.hydration, abortedBy: 'budget' } } : out
    })
    const counts = { customers: {}, suppliers: {} }
    const result = await readCandidateTerms(candidatesFor(numbers), { accessToken: 't' }, Date.now() + 60_000, counts,
      { hydrateCustomers: hydrateCustomers as never, hydrateSuppliers: deps.hydrateSuppliers })
    expect(result.fills).toHaveLength(100)
    expect(result.next).toBe('customers:1100')
  })

  it('stops on a refused token', async () => {
    const counts = { customers: {}, suppliers: {} }
    await expect(readCandidateTerms(candidatesFor(['1']), { accessToken: 't' }, Date.now() + 60_000, counts,
      hydrator({}, { abortedBy: 'auth' }))).rejects.toThrow('Token rejected')
  })
})

const customerRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: null, org_number: null, personal_number: null, vat_number: null, customer_number: null,
  default_payment_terms: 30, ...extra,
})

function companyTables(params: {
  consents?: string[]
  customers?: Record<string, unknown>[]
  suppliers?: Record<string, unknown>[]
  sourceMap?: { resource: string; source_id: string; target_id: string }[]
}) {
  return {
    provider_consents: { data: (params.consents ?? []).map((id) => ({ id })) },
    customers: { data: params.customers ?? [] },
    suppliers: { data: params.suppliers ?? [] },
    migration_source_records: { data: params.sourceMap ?? [] },
  }
}

describe('planFortnoxTermsBackfill', () => {
  it('lists both registers, matches, and reads the detail form of the cards still on 30', async () => {
    const { supabase } = createTableMockSupabase(companyTables({
      consents: ['consent-1'],
      customers: [
        customerRow('c1', { name: 'Kund 1', org_number: '556677-8899' }),
        customerRow('c2', { name: 'Kund 2', default_payment_terms: 15 }),
      ],
      suppliers: [{ id: 's1', name: 'Leverantör 1', org_number: null, vat_number: null, default_payment_terms: 30 }],
      sourceMap: [{ resource: 'suppliers', source_id: '1', target_id: 's1' }],
    }))
    const fetchPage = vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string, page: number) => {
      if (resource === 'customers' && page === 1) return { items: [listed('1', { OrganisationNumber: '5566778899' })], nextPage: 2, total: 2 }
      if (resource === 'customers') return { items: [listed('2')], nextPage: null, total: 2 }
      return { items: [mapFortnoxToSupplier(supplier('1'))], nextPage: null, total: 1 }
    })
    const plan = await planFortnoxTermsBackfill(supabase as unknown as SupabaseClient, COMPANY,
      { from: null, deadline: Date.now() + 60_000 },
      {
        resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 'token' }),
        fetchMigrationPage: fetchPage as never,
        ...hydrator({ 'customers:1': '10', 'suppliers:1': '20' }),
      })
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(plan).toMatchObject({ fortnox: 'fetched', listed: 3, candidates: 2, next: null })
    expect(plan.fills).toEqual([
      { resource: 'customers', id: 'c1', terms: 10 },
      { resource: 'suppliers', id: 's1', terms: 20 },
    ])
    expect(plan.counts).toEqual({ customers: { has_terms: 1, fill: 1 }, suppliers: { fill: 1 } })
  })

  it('reports a company without a Fortnox connection, and an expired one, writing nothing', async () => {
    const none = await planFortnoxTermsBackfill(createTableMockSupabase(companyTables({})).supabase as unknown as SupabaseClient,
      COMPANY, { from: null, deadline: Date.now() + 60_000 })
    expect(none).toMatchObject({ fortnox: 'no_consent', fills: [], next: null })

    const expired = await planFortnoxTermsBackfill(
      createTableMockSupabase(companyTables({ consents: ['consent-1'] })).supabase as unknown as SupabaseClient,
      COMPANY, { from: null, deadline: Date.now() + 60_000 },
      { resolveConsent: vi.fn().mockRejectedValue({ status: 401, message: 'Token expired' }) })
    expect(expired).toMatchObject({ fortnox: 'consent_expired', fortnoxError: 'Token expired', fills: [] })
  })

  it('reads only archive-free cards and only Fortnox source records', async () => {
    const mock = createTableMockSupabase(companyTables({ consents: ['consent-1'] }))
    await planFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, COMPANY,
      { from: null, deadline: Date.now() + 60_000 },
      {
        resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 'token' }),
        fetchMigrationPage: vi.fn().mockResolvedValue({ items: [], nextPage: null, total: 0 }) as never,
      })
    expect(mock.findCall('customers', 'is')).toEqual(['archived_at', null])
    expect(mock.findCall('suppliers', 'is')).toEqual(['archived_at', null])
    expect(mock.findCalls('migration_source_records', 'eq')).toContainEqual(['provider', 'fortnox'])
  })
})

describe('applyTermsFills', () => {
  const fills = [
    { resource: 'customers' as const, id: 'c1', terms: 10 },
    { resource: 'suppliers' as const, id: 's1', terms: 20 },
  ]

  it('writes each card only while it is still on 30', async () => {
    const answered: TableMockResolver = (calls) =>
      ({ data: calls.some((c) => c.method === 'eq' && c.args[1] === 'c1') ? [{ id: 'c1' }] : [] })
    const mock = createTableMockSupabase({ customers: answered, suppliers: answered })
    const result = await applyTermsFills(mock.supabase as unknown as SupabaseClient, COMPANY, fills)
    expect(result).toEqual({ filled: 1, changed: 1, filledIds: ['c1'] })
    expect(mock.payloads('customers', 'update')).toEqual([{ default_payment_terms: 10 }])
    expect(mock.findCalls('customers', 'eq')).toEqual([['id', 'c1'], ['company_id', COMPANY], ['default_payment_terms', 30]])
  })

  it('raises a write error', async () => {
    const mock = createTableMockSupabase({ customers: { error: { message: 'boom' } } })
    await expect(applyTermsFills(mock.supabase as unknown as SupabaseClient, COMPANY, fills.slice(0, 1)))
      .rejects.toThrow('customers: boom')
  })
})

describe('runFortnoxTermsBackfill', () => {
  const A = 'company-a'
  const B = 'company-b'

  /** Two companies with a live connection; A is already finished. */
  function cronTables(params: {
    progress?: Record<string, unknown>[]
    archived?: string[]
    reset?: string[]
    customers?: Record<string, Record<string, unknown>[]>
    sourceMap?: Record<string, { resource: string; source_id: string; target_id: string }[]>
  } = {}) {
    const byCompany = <T,>(map: Record<string, T[]> | undefined): TableMockResolver => (calls) =>
      ({ data: map?.[String(eqArg(calls, 'company_id'))] ?? [] })
    return createTableMockSupabase({
      provider_consents: (calls) => ({
        data: eqArg(calls, 'company_id') ? [{ id: `consent-${eqArg(calls, 'company_id')}` }] : [{ company_id: A }, { company_id: B }],
      }),
      fortnox_terms_backfill_progress: (calls) =>
        ({ data: calls.some((c) => c.method === 'upsert') ? null : params.progress ?? [] }),
      companies: (calls) => ({ data: { archived_at: (params.archived ?? []).includes(String(eqArg(calls, 'id'))) ? '2026-01-01' : null } }),
      company_migration_resets: (calls) =>
        ({ data: (params.reset ?? []).includes(String(eqArg(calls, 'source_company_id'))) ? [{ id: 'r' }] : [] }),
      customers: (calls) => (calls.some((c) => c.method === 'update')
        ? { data: [{ id: String(eqArg(calls, 'id')) }] }
        : byCompany(params.customers)(calls)),
      suppliers: { data: [] },
      migration_source_records: byCompany(params.sourceMap),
    })
  }

  const fortnox = (terms: Record<string, string>) => ({
    resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 'token' }),
    fetchMigrationPage: vi.fn(async (_p: unknown, _t: unknown, _c: unknown, resource: string) => ({
      items: resource === 'customers' ? [listed('1')] : [], nextPage: null, total: 1,
    })) as never,
    ...hydrator(terms),
  })

  it('works only on companies without an outcome and records what it changed', async () => {
    const mock = cronTables({
      progress: [{ company_id: A, next_key: null, outcome: 'done', attempts: 0, filled_customer_ids: [], filled_supplier_ids: [] }],
      customers: { [B]: [customerRow('c1')] },
      sourceMap: { [B]: [{ resource: 'customers', source_id: '1', target_id: 'c1' }] },
    })
    const summary = await runFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, Date.now() + 120_000,
      fortnox({ 'customers:1': '10' }))
    expect(summary).toEqual({ pending: 1, worked: 1, finished: 1, filled: 1 })
    expect(mock.payloads('customers', 'update')).toEqual([{ default_payment_terms: 10 }])
    expect(mock.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([expect.objectContaining({
      company_id: B, outcome: 'done', attempts: 0, filled_customer_ids: ['c1'], filled_supplier_ids: [], last_error: null,
    })])
  })

  it('stores the cursor of a run the deadline cut short, and leaves the company pending', async () => {
    const mock = cronTables({
      progress: [{ company_id: A, next_key: null, outcome: 'done', attempts: 0, filled_customer_ids: [], filled_supplier_ids: [] }],
      customers: { [B]: [customerRow('c1')] },
      sourceMap: { [B]: [{ resource: 'customers', source_id: '1', target_id: 'c1' }] },
    })
    const deps = { ...fortnox({}), ...hydrator({}, { abortedBy: 'budget' }) }
    const summary = await runFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, Date.now() + 120_000, deps)
    expect(summary).toMatchObject({ worked: 1, finished: 0, filled: 0 })
    expect(mock.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([
      expect.objectContaining({ company_id: B, next_key: 'customers:1', outcome: null }),
    ])
  })

  it('gives a company up after three runs that read nothing new', async () => {
    const mock = cronTables({
      progress: [
        { company_id: A, next_key: null, outcome: 'done', attempts: 0, filled_customer_ids: [], filled_supplier_ids: [] },
        { company_id: B, next_key: 'customers:1', outcome: null, attempts: 2, filled_customer_ids: [], filled_supplier_ids: [] },
      ],
      customers: { [B]: [customerRow('c1')] },
      sourceMap: { [B]: [{ resource: 'customers', source_id: '1', target_id: 'c1' }] },
    })
    const deps = { ...fortnox({}), ...hydrator({}, { abortedBy: 'budget' }) }
    await runFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, Date.now() + 120_000, deps)
    expect(mock.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([
      expect.objectContaining({ company_id: B, outcome: 'stuck', attempts: 3 }),
    ])
  })

  it('finishes an archived, a migration-reset and an expired-connection company without writing a card', async () => {
    const archived = cronTables({ archived: [A, B] })
    await runFortnoxTermsBackfill(archived.supabase as unknown as SupabaseClient, Date.now() + 120_000, fortnox({}))
    expect(archived.payloads('fortnox_terms_backfill_progress', 'upsert'))
      .toEqual([expect.objectContaining({ outcome: 'archived' }), expect.objectContaining({ outcome: 'archived' })])

    const reset = cronTables({ reset: [A, B] })
    await runFortnoxTermsBackfill(reset.supabase as unknown as SupabaseClient, Date.now() + 120_000, fortnox({}))
    expect(reset.payloads('fortnox_terms_backfill_progress', 'upsert'))
      .toEqual([expect.objectContaining({ outcome: 'migration_reset' }), expect.objectContaining({ outcome: 'migration_reset' })])

    const expired = cronTables()
    await runFortnoxTermsBackfill(expired.supabase as unknown as SupabaseClient, Date.now() + 120_000,
      { resolveConsent: vi.fn().mockRejectedValue({ status: 401, message: 'Token expired' }) })
    expect(expired.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([
      expect.objectContaining({ outcome: 'consent_expired', last_error: 'Token expired' }),
      expect.objectContaining({ outcome: 'consent_expired' }),
    ])
    for (const mock of [archived, reset, expired]) expect(mock.payloads('customers', 'update')).toEqual([])
  })

  it('counts a failure and retries the company in a later run', async () => {
    const mock = cronTables({
      progress: [{ company_id: A, next_key: null, outcome: 'done', attempts: 0, filled_customer_ids: [], filled_supplier_ids: [] }],
    })
    await runFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, Date.now() + 120_000,
      { resolveConsent: vi.fn().mockRejectedValue(new Error('Fortnox 503')) })
    expect(mock.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([
      expect.objectContaining({ company_id: B, outcome: null, attempts: 1, last_error: 'Fortnox 503' }),
    ])
  })

  it('starts no company with less than 30 s left', async () => {
    const mock = cronTables()
    const summary = await runFortnoxTermsBackfill(mock.supabase as unknown as SupabaseClient, Date.now() + 10_000, fortnox({}))
    expect(summary).toEqual({ pending: 2, worked: 0, finished: 0, filled: 0 })
    expect(mock.payloads('fortnox_terms_backfill_progress', 'upsert')).toEqual([])
  })
})
