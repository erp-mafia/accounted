import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FABRICATED_PAID_AT_CREATED_BEFORE,
  hasFabricatedSignature,
  repairMigratedInvoicePaidAt,
  resolvePaidAt,
} from '../repair-migrated-invoice-paid-at'

/**
 * The repair of the payment date the migration fabricated before #2769
 * (#2798 C). Most of this file is about the boundary: which rows are provably
 * fabricated, and which only look it. Nulling a real same-day settlement
 * would be new damage, so every "left alone" rule has its own case.
 */

const COMPANY = 'company-1'

interface InvoiceFixture {
  id: string
  invoice_date: string
  paid_at: string | null
  created_at: string
  status?: string
}

/** A row exactly as the old mapper wrote it: a bare date, stored as UTC midnight. */
function fabricated(id: string, invoiceDate: string, overrides: Partial<InvoiceFixture> = {}): InvoiceFixture {
  return {
    id,
    invoice_date: invoiceDate,
    paid_at: `${invoiceDate}T00:00:00+00:00`,
    created_at: '2026-06-01T09:30:00+00:00',
    ...overrides,
  }
}

interface World {
  invoices: InvoiceFixture[]
  consents?: { provider: string | null }[]
  /** Providers named by InvoiceRowsCompleted events of the company. */
  trailProviders?: string[]
  payments?: { id: string; invoice_id: string; journal_entry_id: string | null }[]
  journalEntries?: { id: string; entry_date: string; status: string }[]
  /** Makes every invoices UPDATE fail with this error. */
  updateError?: { code: string; message: string }
  /** Ids the UPDATE matches nothing for: someone else wrote the row first. */
  changedSinceRead?: string[]
  /** A client whose reads drop the created_at filter: a regressed query. */
  readsIgnoreCutoff?: boolean
}

type Filter = [op: string, column: string, value: unknown]

/**
 * A PostgREST-shaped fake that applies the filters it is given, so the pass
 * is tested against what its queries select, not against canned answers.
 */
function fakeSupabase(world: World) {
  const updates: { values: Record<string, unknown>; filters: Filter[] }[] = []
  const reads: { table: string; filters: Filter[] }[] = []

  const tableRows = (table: string): Record<string, unknown>[] => {
    if (table === 'invoices') return world.invoices.map((row) => ({ status: 'paid', company_id: COMPANY, ...row }))
    if (table === 'provider_consents') return (world.consents ?? []).map((row) => ({ company_id: COMPANY, ...row }))
    if (table === 'invoice_payments') return (world.payments ?? []).map((row) => ({ company_id: COMPANY, ...row }))
    if (table === 'journal_entries') return (world.journalEntries ?? []).map((row) => ({ company_id: COMPANY, ...row }))
    if (table === 'processing_history') {
      return (world.trailProviders ?? []).map((provider, i) => ({
        company_id: COMPANY,
        event_id: `event-${i}`,
        event_type: 'InvoiceRowsCompleted',
        'payload->>provider': provider,
      }))
    }
    throw new Error(`unexpected table ${table}`)
  }

  const matches = (row: Record<string, unknown>, [op, column, value]: Filter): boolean => {
    const cell = row[column]
    switch (op) {
      case 'eq': return cell === value
      case 'in': return (value as unknown[]).includes(cell)
      case 'lt': return Date.parse(String(cell)) < Date.parse(String(value))
      case 'not.is': return cell !== value
      case 'not.in': {
        const listed = String(value).replace(/[()"]/g, '').split(',')
        return cell != null && !listed.includes(String(cell))
      }
      default: throw new Error(`unexpected filter ${op}`)
    }
  }

  const builder = (table: string, update?: Record<string, unknown>) => {
    const filters: Filter[] = []
    let range: [number, number] | null = null
    let limit: number | null = null
    if (update) updates.push({ values: update, filters })
    else reads.push({ table, filters })

    const run = () => {
      if (update && world.updateError) return { data: null, error: world.updateError }
      let rows = tableRows(table).filter((row) => filters.every((f) => matches(row, f)))
      if (update) {
        rows = rows.filter((row) => !(world.changedSinceRead ?? []).includes(String(row.id)))
        for (const row of rows) {
          const target = world.invoices.find((invoice) => invoice.id === row.id)
          if (target) Object.assign(target, update)
        }
      }
      if (range) rows = rows.slice(range[0], range[1] + 1)
      if (limit !== null) rows = rows.slice(0, limit)
      return { data: rows, error: null }
    }

    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return chain },
      in: (column: string, value: unknown) => { filters.push(['in', column, value]); return chain },
      lt: (column: string, value: unknown) => {
        if (!(world.readsIgnoreCutoff && !update)) filters.push(['lt', column, value])
        return chain
      },
      not: (column: string, op: string, value: unknown) => { filters.push([`not.${op}`, column, value]); return chain },
      order: () => chain,
      range: (from: number, to: number) => { range = [from, to]; return chain },
      limit: (n: number) => { limit = n; return chain },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    }
    return chain
  }

  const supabase = {
    from: vi.fn((table: string) => ({
      select: () => builder(table).select(),
      update: (values: Record<string, unknown>) => builder(table, values),
    })),
  } as unknown as SupabaseClient

  return { supabase, updates, reads }
}

const FORTNOX = [{ provider: 'fortnox' }]

describe('hasFabricatedSignature', () => {
  it('matches the invoice date at exactly midnight UTC, however the offset is spelled', () => {
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T00:00:00+00:00' })).toBe(true)
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T00:00:00Z' })).toBe(true)
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T00:00:00.000000+00:00' })).toBe(true)
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T02:00:00+02:00' })).toBe(true)
  })

  it('does not match a payment registered in Accounted on the invoice date', () => {
    // paidAtFromDate (since #1332) and the link/allocate RPCs: UTC noon.
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T12:00:00+00:00' })).toBe(false)
    // Before #1332: the wall clock at the moment of "Markera som betald".
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T09:41:07.512+00:00' })).toBe(false)
    // A wall-clock value inside the first millisecond of the day is still a wall clock.
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T00:00:00.000417+00:00' })).toBe(false)
  })

  it('does not match a real provider date, a null, or a local midnight', () => {
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-04-02T00:00:00+00:00' })).toBe(false)
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: null })).toBe(false)
    // Stockholm midnight is 23:00 UTC the day before: not what the mapper wrote.
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: '2025-03-14T00:00:00+01:00' })).toBe(false)
    expect(hasFabricatedSignature({ invoice_date: '2025-03-14', paid_at: 'not a date' })).toBe(false)
  })
})

describe('resolvePaidAt', () => {
  const entry = (id: string, entryDate: string, status = 'posted') => ({ id, entry_date: entryDate, status })

  it('has no date when nothing names one', () => {
    expect(resolvePaidAt({ paymentRows: 0, journalEntries: [] })).toEqual({ kind: 'unknown' })
  })

  it('takes the entry date of the one posted journal entry the payment rows point at', () => {
    expect(resolvePaidAt({ paymentRows: 1, journalEntries: [entry('je-1', '2025-04-02')] }))
      .toEqual({ kind: 'date', date: '2025-04-02', source: 'journal_entry' })
    // Two rows on the same voucher are still one voucher.
    expect(resolvePaidAt({ paymentRows: 2, journalEntries: [entry('je-1', '2025-04-02'), entry('je-1', '2025-04-02')] }))
      .toEqual({ kind: 'date', date: '2025-04-02', source: 'journal_entry' })
  })

  it('is ambiguous, never unknown, when payment rows do not name exactly one posted entry', () => {
    expect(resolvePaidAt({ paymentRows: 2, journalEntries: [entry('je-1', '2025-04-02'), entry('je-2', '2025-05-02')] }))
      .toEqual({ kind: 'ambiguous' })
    expect(resolvePaidAt({ paymentRows: 1, journalEntries: [null] })).toEqual({ kind: 'ambiguous' })
    expect(resolvePaidAt({ paymentRows: 2, journalEntries: [entry('je-1', '2025-04-02'), null] })).toEqual({ kind: 'ambiguous' })
    expect(resolvePaidAt({ paymentRows: 1, journalEntries: [entry('je-1', '2025-04-02', 'reversed')] })).toEqual({ kind: 'ambiguous' })
    expect(resolvePaidAt({ paymentRows: 1, journalEntries: [entry('je-1', '2025-04-02', 'draft')] })).toEqual({ kind: 'ambiguous' })
  })

  it('ranks the provider date above the journal-entry date (the slot part B fills)', () => {
    expect(resolvePaidAt({
      providerPaymentDate: '2025-03-29',
      paymentRows: 1,
      journalEntries: [entry('je-1', '2025-04-02')],
    })).toEqual({ kind: 'date', date: '2025-03-29', source: 'provider' })
    // It also settles a row whose payment rows alone would be ambiguous.
    expect(resolvePaidAt({ providerPaymentDate: '2025-03-29T00:00:00', paymentRows: 1, journalEntries: [null] }))
      .toEqual({ kind: 'date', date: '2025-03-29', source: 'provider' })
  })

  it('ignores a provider value that is not a calendar day', () => {
    expect(resolvePaidAt({ providerPaymentDate: '', paymentRows: 0, journalEntries: [] })).toEqual({ kind: 'unknown' })
    expect(resolvePaidAt({ providerPaymentDate: '2025-02-30', paymentRows: 0, journalEntries: [] })).toEqual({ kind: 'unknown' })
  })
})

describe('repairMigratedInvoicePaidAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('nulls a fabricated date when nothing names the real one and the provider never supplied dates', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14'), fabricated('inv-2', '2025-03-14')], consents: FORTNOX }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result).toMatchObject({ candidates: 2, setToNull: 2, setToDate: 0, providers: ['fortnox'], writeError: null, dryRun: false })
    expect(world.invoices.map((row) => row.paid_at)).toEqual([null, null])
    // Only paid_at is ever written.
    expect(updates.every((u) => Object.keys(u.values).join() === 'paid_at')).toBe(true)
  })

  it('scopes every write as a compare-and-set on the company, the status, the stored value and the cutoff', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: FORTNOX }
    const { supabase, updates } = fakeSupabase(world)

    await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(updates).toHaveLength(1)
    expect(updates[0].filters).toEqual(expect.arrayContaining([
      ['eq', 'company_id', COMPANY],
      ['eq', 'status', 'paid'],
      ['eq', 'paid_at', '2025-03-14T00:00:00+00:00'],
      ['lt', 'created_at', FABRICATED_PAID_AT_CREATED_BEFORE],
      ['in', 'id', ['inv-1']],
    ]))
  })

  it('reads only paid invoices of the company with a date, created before the fix', async () => {
    const { supabase, reads } = fakeSupabase({ invoices: [], consents: FORTNOX })

    await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(reads[0]).toEqual({
      table: 'invoices',
      filters: [
        ['eq', 'company_id', COMPANY],
        ['eq', 'status', 'paid'],
        ['not.is', 'paid_at', null],
        ['lt', 'created_at', FABRICATED_PAID_AT_CREATED_BEFORE],
      ],
    })
  })

  it('never touches an invoice paid in Accounted on its own invoice date (card, Swish, cash register)', async () => {
    const world: World = {
      invoices: [
        fabricated('native-noon', '2025-03-14', { paid_at: '2025-03-14T12:00:00+00:00' }),
        fabricated('native-wall-clock', '2025-03-14', { paid_at: '2025-03-14T15:02:44.193+00:00' }),
      ],
      consents: FORTNOX,
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.candidates).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('never touches a row created at or after #2769, whose same-day date came from the provider', async () => {
    const world: World = {
      invoices: [
        fabricated('after-fix', '2026-09-21', { created_at: '2026-09-21T08:00:00+00:00' }),
        fabricated('at-the-cutoff', '2026-09-20', { created_at: FABRICATED_PAID_AT_CREATED_BEFORE }),
      ],
      consents: FORTNOX,
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.candidates).toBe(0)
    expect(updates).toHaveLength(0)
    expect(world.invoices.every((row) => row.paid_at !== null)).toBe(true)
  })

  it('applies the cutoff itself, not only through the query filter', async () => {
    // A read that loses its created_at filter must not widen the repair.
    const world: World = {
      invoices: [fabricated('after-fix', '2026-09-21', { created_at: '2026-09-21T08:00:00+00:00' })],
      consents: FORTNOX,
      readsIgnoreCutoff: true,
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.candidates).toBe(0)
    expect(updates).toHaveLength(0)
    expect(world.invoices[0].paid_at).toBe('2026-09-21T00:00:00+00:00')
  })

  it('leaves a Visma or WINT row alone: its mapper reads real dates, so the value may be true', async () => {
    for (const provider of ['visma', 'wint']) {
      const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: [{ provider }] }
      const { supabase, updates } = fakeSupabase(world)

      const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

      expect(result).toMatchObject({ candidates: 1, setToNull: 0, setToDate: 0 })
      expect(result.leftAlone.providerMaySupplyDate).toBe(1)
      expect(updates).toHaveLength(0)
      expect(world.invoices[0].paid_at).toBe('2025-03-14T00:00:00+00:00')
    }
  })

  it('holds the whole company when any of its providers reads real dates', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: [{ provider: 'fortnox' }, { provider: 'visma' }] }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.leftAlone.providerMaySupplyDate).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('treats a provider it does not know as one that may supply dates', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: [{ provider: 'some-new-provider' }] }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.leftAlone.providerMaySupplyDate).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('holds the null branch when the migration trail names a date-supplying provider the consents no longer show', async () => {
    // Visma consent deleted, Fortnox consent still there: the trail remembers.
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: FORTNOX, trailProviders: ['fortnox', 'visma'] }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.leftAlone.providerMaySupplyDate).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('leaves rows alone when nothing says which provider wrote them', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: [] }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result).toMatchObject({ candidates: 1, setToNull: 0, providers: [] })
    expect(result.leftAlone.providerUnknown).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('accepts the migration trail as provider evidence when the consent was deleted', async () => {
    const world: World = { invoices: [fabricated('inv-1', '2025-03-14')], consents: [], trailProviders: ['bokio'] }
    const { supabase } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result).toMatchObject({ setToNull: 1, providers: [] })
    expect(world.invoices[0].paid_at).toBeNull()
  })

  it('writes the entry date of the one posted journal entry, at UTC noon like every settlement path', async () => {
    const world: World = {
      invoices: [fabricated('inv-1', '2025-03-14')],
      // Even a Visma company: a named date needs no assumption about the provider.
      consents: [{ provider: 'visma' }],
      payments: [{ id: 'pay-1', invoice_id: 'inv-1', journal_entry_id: 'je-1' }],
      journalEntries: [{ id: 'je-1', entry_date: '2025-04-02', status: 'posted' }],
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result).toMatchObject({ setToDate: 1, setToNull: 0, setToDateBySource: { journal_entry: 1, provider: 0 } })
    expect(updates[0].values).toEqual({ paid_at: '2025-04-02T12:00:00Z' })
    expect(world.invoices[0].paid_at).toBe('2025-04-02T12:00:00Z')
  })

  it('leaves the row alone when the journal entry confirms the invoice date', async () => {
    const world: World = {
      invoices: [fabricated('inv-1', '2025-03-14')],
      consents: FORTNOX,
      payments: [{ id: 'pay-1', invoice_id: 'inv-1', journal_entry_id: 'je-1' }],
      journalEntries: [{ id: 'je-1', entry_date: '2025-03-14', status: 'posted' }],
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.leftAlone.confirmedBySource).toBe(1)
    expect(result.setToNull).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('never nulls an invoice that has payment rows it cannot date', async () => {
    const world: World = {
      invoices: [fabricated('two-vouchers', '2025-03-14'), fabricated('no-voucher', '2025-03-14'), fabricated('reversed', '2025-03-14')],
      consents: FORTNOX,
      payments: [
        { id: 'pay-1', invoice_id: 'two-vouchers', journal_entry_id: 'je-1' },
        { id: 'pay-2', invoice_id: 'two-vouchers', journal_entry_id: 'je-2' },
        { id: 'pay-3', invoice_id: 'no-voucher', journal_entry_id: null },
        { id: 'pay-4', invoice_id: 'reversed', journal_entry_id: 'je-3' },
      ],
      journalEntries: [
        { id: 'je-1', entry_date: '2025-04-02', status: 'posted' },
        { id: 'je-2', entry_date: '2025-05-02', status: 'posted' },
        { id: 'je-3', entry_date: '2025-04-02', status: 'reversed' },
      ],
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result).toMatchObject({ candidates: 3, setToNull: 0, setToDate: 0 })
    expect(result.leftAlone.ambiguousPaymentRows).toBe(3)
    expect(updates).toHaveLength(0)
  })

  it('does not read a journal entry of another company through a payment row', async () => {
    const world: World = {
      invoices: [fabricated('inv-1', '2025-03-14')],
      consents: FORTNOX,
      payments: [{ id: 'pay-1', invoice_id: 'inv-1', journal_entry_id: 'je-foreign' }],
      journalEntries: [],
    }
    const { supabase, reads, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    const entryRead = reads.find((read) => read.table === 'journal_entries')!
    expect(entryRead.filters).toEqual(expect.arrayContaining([['eq', 'company_id', COMPANY]]))
    // The entry did not resolve inside the company: ambiguous, not nulled.
    expect(result.leftAlone.ambiguousPaymentRows).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('lets a provider-supplied date outrank the journal entry and lift the Visma hold (part B)', async () => {
    const world: World = {
      invoices: [fabricated('with-voucher', '2025-03-14'), fabricated('provider-only', '2025-03-14'), fabricated('same-day', '2025-03-14'), fabricated('not-covered', '2025-03-14')],
      consents: [{ provider: 'visma' }],
      payments: [{ id: 'pay-1', invoice_id: 'with-voucher', journal_entry_id: 'je-1' }],
      journalEntries: [{ id: 'je-1', entry_date: '2025-04-02', status: 'posted' }],
    }
    const { supabase } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({
      supabase,
      companyId: COMPANY,
      providerPaymentDates: new Map([
        ['with-voucher', '2025-03-29'],
        ['provider-only', '2025-03-21'],
        // The provider confirms a genuine same-day payment: kept, not nulled.
        ['same-day', '2025-03-14'],
      ]),
    })

    expect(result).toMatchObject({ setToDate: 2, setToNull: 0, setToDateBySource: { provider: 2, journal_entry: 0 } })
    expect(result.leftAlone).toMatchObject({ confirmedBySource: 1, providerMaySupplyDate: 1 })
    expect(world.invoices.map((row) => row.paid_at)).toEqual([
      '2025-03-29T12:00:00Z',
      '2025-03-21T12:00:00Z',
      '2025-03-14T00:00:00+00:00',
      '2025-03-14T00:00:00+00:00',
    ])
  })

  it('writes nothing on a dry run but reports the same counts', async () => {
    const build = (): World => ({
      invoices: [fabricated('inv-1', '2025-03-14'), fabricated('inv-2', '2025-03-15')],
      consents: FORTNOX,
      payments: [{ id: 'pay-1', invoice_id: 'inv-2', journal_entry_id: 'je-1' }],
      journalEntries: [{ id: 'je-1', entry_date: '2025-04-02', status: 'posted' }],
    })
    const dryWorld = build()
    const dry = fakeSupabase(dryWorld)
    const wet = fakeSupabase(build())

    const dryResult = await repairMigratedInvoicePaidAt({ supabase: dry.supabase, companyId: COMPANY, dryRun: true })
    const wetResult = await repairMigratedInvoicePaidAt({ supabase: wet.supabase, companyId: COMPANY })

    expect(dry.updates).toHaveLength(0)
    expect(dryWorld.invoices.map((row) => row.paid_at)).toEqual(['2025-03-14T00:00:00+00:00', '2025-03-15T00:00:00+00:00'])
    expect(dryResult).toEqual({ ...wetResult, dryRun: true })
    expect(dryResult).toMatchObject({ setToNull: 1, setToDate: 1 })
  })

  it('is idempotent: a second run finds nothing to write', async () => {
    const world: World = {
      invoices: [fabricated('inv-1', '2025-03-14'), fabricated('inv-2', '2025-03-15')],
      consents: FORTNOX,
      payments: [{ id: 'pay-1', invoice_id: 'inv-2', journal_entry_id: 'je-1' }],
      journalEntries: [{ id: 'je-1', entry_date: '2025-04-02', status: 'posted' }],
    }
    const { supabase, updates } = fakeSupabase(world)

    await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })
    const writesAfterFirst = updates.length
    const second = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(writesAfterFirst).toBe(2)
    expect(updates).toHaveLength(writesAfterFirst)
    expect(second).toMatchObject({ candidates: 0, setToNull: 0, setToDate: 0 })
  })

  it('reports a row someone else wrote between the read and the write, and does not count it as repaired', async () => {
    const world: World = {
      invoices: [fabricated('inv-1', '2025-03-14'), fabricated('inv-2', '2025-03-14')],
      consents: FORTNOX,
      changedSinceRead: ['inv-2'],
    }
    const { supabase } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.setToNull).toBe(1)
    expect(result.leftAlone.changedSinceRead).toBe(1)
  })

  it('stops on a refused write and reports it instead of working around the trigger', async () => {
    // 700 rows on 7 dates: 7 compare-and-set writes, more than one slice.
    const invoices = Array.from({ length: 700 }, (_, i) => fabricated(`inv-${i}`, `2025-03-${String(10 + (i % 7)).padStart(2, '0')}`))
    const world: World = {
      invoices,
      consents: FORTNOX,
      updateError: { code: 'P0001', message: 'Archived migration reset source records are immutable' },
    }
    const { supabase, updates } = fakeSupabase(world)

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.writeError).toEqual({ code: 'P0001', message: 'Archived migration reset source records are immutable' })
    expect(result.setToNull).toBe(0)
    expect(result.leftAlone.notWritten).toBe(700)
    // The first slice was in flight; nothing after it was attempted.
    expect(updates.length).toBeLessThan(7)
    expect(world.invoices.every((row) => row.paid_at !== null)).toBe(true)
  })

  it('keeps every id list short enough for one request line', async () => {
    const invoices = Array.from({ length: 250 }, (_, i) => fabricated(`inv-${i}`, '2025-03-14'))
    const { supabase, updates } = fakeSupabase({ invoices, consents: FORTNOX })

    const result = await repairMigratedInvoicePaidAt({ supabase, companyId: COMPANY })

    expect(result.setToNull).toBe(250)
    expect(updates).toHaveLength(3)
    for (const update of updates) {
      const ids = update.filters.find(([op, column]) => op === 'in' && column === 'id')![2] as string[]
      expect(ids.length).toBeLessThanOrEqual(100)
    }
  })
})
