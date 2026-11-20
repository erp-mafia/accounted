import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  applyFortnoxNumberRepair,
  collectFortnoxRecords,
  correctedCompanies,
  fortnoxNumberRecord,
  repairBlocker,
  repairFortnoxSupplierNumbers,
  revertFortnoxNumberRepair,
  type FortnoxNumberRecord,
} from '../repair-fortnox-supplier-numbers'

/**
 * crm#1157, step 3a: the collector behind repair_fortnox_supplier_invoice_numbers.
 * It reads the supplier's number from the raw Fortnox field, takes stored
 * import payloads first, asks Fortnox only for invoices they do not cover,
 * reports an expired connection instead of failing, and never sends a
 * company whose records carry no InvoiceNumber to the RPC.
 */

const COMPANY = 'company-1'

function raw(given: string, invoiceNumber: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    GivenNumber: given,
    ...(invoiceNumber === undefined ? {} : { InvoiceNumber: invoiceNumber }),
    InvoiceDate: '2026-06-01',
    DueDate: '2026-06-30',
    SupplierName: 'Frakt AB',
    Total: 1250,
    Currency: 'SEK',
    ...extra,
  }
}

const dto = (r: Record<string, unknown>) => mapFortnoxToSupplierInvoice(r)

type Tables = Parameters<typeof createTableMockSupabase>[0]

const RPC = 'rpc:repair_fortnox_supplier_invoice_numbers'

function fake(tables: Tables = {}) {
  const mock = createTableMockSupabase(tables)
  const rpcArgs = () => mock.findCalls(RPC, 'rpc').map(([args]) => args as Record<string, unknown>)
  return { client: mock.supabase as unknown as SupabaseClient, rpcArgs }
}

/**
 * A company's tables, in the order the collector reads them: its Fortnox
 * import jobs and their stored payloads, then the count of invoices without a
 * löpnummer and the stamped ones (twice: again after a Fortnox fetch), its
 * Fortnox consents, and whether it is a migration-reset source.
 */
function companyTables(params: {
  payloads?: Record<string, unknown>[]
  unstamped?: number
  stamped?: string[]
  consents?: string[]
  frozen?: boolean
}): Tables {
  const unstamped = { count: params.unstamped ?? 0 }
  const stamped = { data: (params.stamped ?? []).map((n, i) => ({ id: `si-${i}`, fortnox_number: n })) }
  return {
    migration_jobs: { data: params.payloads ? [{ id: 'job-1' }] : [] },
    migration_job_chunks: {
      data: (params.payloads ?? []).map((p, i) => ({ id: `chunk-${i}`, payload: JSON.stringify(dto(p)) })),
    },
    supplier_invoices: [unstamped, stamped, unstamped, stamped],
    provider_consents: { data: (params.consents ?? []).map((id) => ({ id })) },
    company_migration_resets: { data: params.frozen ? [{ id: 'reset-1' }] : [] },
  }
}

const openJson = <T,>(payload: string) => JSON.parse(payload) as T

describe('fortnoxNumberRecord', () => {
  it('reads the löpnummer and the supplier number from the raw Fortnox fields, with the header the import stores', () => {
    const record = fortnoxNumberRecord(dto(raw('367', 'INV-9001')), COMPANY, 'fortnox')
    expect(record).toEqual({
      given_number: '367',
      invoice_number: 'INV-9001',
      invoice_date: '2026-06-01',
      total: 1250,
      currency: 'SEK',
      is_credit_note: false,
      source: 'fortnox',
    })
  })

  it('reads the header of a stored list record whose Total Fortnox serialised as a string (crm#1157)', () => {
    // The stored payload is the list form, sealed with the mapper of its
    // import day: one from before the string Total was parsed carries the
    // string in its amounts. Read from the DTO, the header had no total and
    // every ordinary invoice read as header_mismatch; read from _raw it has.
    const listed = dto(raw('403', '6994', { Total: '1415.00', Balance: '1415.00' }))
    const sealedBefore = JSON.parse(JSON.stringify({
      ...listed,
      legalMonetaryTotal: {
        ...listed.legalMonetaryTotal,
        taxInclusiveAmount: { ...listed.legalMonetaryTotal.taxInclusiveAmount, value: '1415.00' },
        payableAmount: { ...listed.legalMonetaryTotal.payableAmount, value: '1415.00' },
      },
    }))
    expect(fortnoxNumberRecord(sealedBefore, COMPANY, 'stored_payload')).toMatchObject({
      given_number: '403', invoice_number: '6994', invoice_date: '2026-06-01', total: 1415, currency: 'SEK', is_credit_note: false,
    })
  })

  it('keeps a numeric supplier number as text and stores a credit note as a magnitude beside its flag', () => {
    const record = fortnoxNumberRecord(dto(raw('12', 21879926, { Total: -400, Credit: true })), COMPANY, 'stored_payload')
    expect(record).toMatchObject({ given_number: '12', invoice_number: '21879926', total: 400, is_credit_note: true })
  })

  it('has no supplier number when Fortnox sends none, and no record without a löpnummer', () => {
    expect(fortnoxNumberRecord(dto(raw('13', undefined)), COMPANY, 'fortnox')?.invoice_number).toBeNull()
    expect(fortnoxNumberRecord(dto(raw('', 'INV-1')), COMPANY, 'fortnox')).toBeNull()
  })

  it('trims the supplier number the way the import stores it, and reads a blank one as none', () => {
    expect(fortnoxNumberRecord(dto(raw('15', '  INV-15 ')), COMPANY, 'fortnox')?.invoice_number).toBe('INV-15')
    expect(fortnoxNumberRecord(dto(raw('16', '   ')), COMPANY, 'fortnox')?.invoice_number).toBeNull()
  })

  it('never takes the mapper invoiceNumber for the supplier number', () => {
    // A payload stored before step 2 carries the löpnummer in invoiceNumber.
    const d = { ...dto(raw('14', undefined)), invoiceNumber: '14' }
    expect(fortnoxNumberRecord(d, COMPANY, 'stored_payload')?.invoice_number).toBeNull()
  })
})

describe('collectFortnoxRecords', () => {
  it('uses the stored payloads alone when they cover every invoice, without asking Fortnox', async () => {
    const { client } = fake(companyTables({ payloads: [raw('1', 'A-1'), raw('2', 'A-2')], stamped: ['1', '2'] }))
    const resolve = vi.fn()
    const collection = await collectFortnoxRecords(client, COMPANY, { fetchFromFortnox: true },
      { openPayload: openJson, resolveConsent: resolve })
    expect(collection).toMatchObject({ stored: 2, fetched: 0, uncovered: 0, fortnox: 'not_needed', invoiceNumberSeen: true })
    expect(collection.records.map((r) => [r.given_number, r.invoice_number, r.source]))
      .toEqual([['1', 'A-1', 'stored_payload'], ['2', 'A-2', 'stored_payload']])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('asks Fortnox for invoices no payload covers, every page, and lets the current Fortnox record win', async () => {
    const { client } = fake(companyTables({ payloads: [raw('1', 'OLD-1')], stamped: ['1'], unstamped: 3, consents: ['c-1'] }))
    const resolve = vi.fn().mockResolvedValue({ consent: {}, accessToken: 'tok' })
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [dto(raw('1', 'NEW-1')), dto(raw('5', 'A-5'))], nextPage: 2, total: 3 })
      .mockResolvedValueOnce({ items: [dto(raw('6', 'A-6'))], nextPage: null, total: 3 })
    const collection = await collectFortnoxRecords(client, COMPANY, { fetchFromFortnox: true },
      { openPayload: openJson, resolveConsent: resolve, fetchMigrationPage: fetchPage })
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(fetchPage.mock.calls[0]).toEqual(['fortnox', 'tok', undefined, 'supplierInvoices', 1, { allSupplierInvoices: true }])
    expect(fetchPage.mock.calls[1][4]).toBe(2)
    expect(collection).toMatchObject({ stored: 1, fetched: 3, fortnox: 'fetched' })
    expect(collection.records.map((r) => [r.given_number, r.invoice_number, r.source])).toEqual([
      ['1', 'NEW-1', 'fortnox'], ['5', 'A-5', 'fortnox'], ['6', 'A-6', 'fortnox'],
    ])
  })

  it('reports an expired connection after trying every consent and keeps the stored records', async () => {
    const { client } = fake(companyTables({ payloads: [raw('1', 'A-1')], stamped: ['1'], unstamped: 2, consents: ['c-new', 'c-old'] }))
    const resolve = vi.fn()
      .mockRejectedValueOnce(new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'expired'))
      .mockRejectedValueOnce({ status: 403, message: 'Consent is not in a valid status' })
    const collection = await collectFortnoxRecords(client, COMPANY, { fetchFromFortnox: true },
      { openPayload: openJson, resolveConsent: resolve, fetchMigrationPage: vi.fn() })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(collection).toMatchObject({ fortnox: 'consent_expired', stored: 1, fetched: 0 })
    expect(collection.records).toHaveLength(1)
  })

  it('reports a company without a Fortnox consent, a skipped fetch, and any other failure without throwing', async () => {
    const noConsent = fake(companyTables({ unstamped: 1 }))
    expect((await collectFortnoxRecords(noConsent.client, COMPANY, { fetchFromFortnox: true }, { openPayload: openJson })).fortnox)
      .toBe('no_consent')

    const skipped = fake(companyTables({ unstamped: 1, consents: ['c-1'] }))
    const resolve = vi.fn()
    expect((await collectFortnoxRecords(skipped.client, COMPANY, { fetchFromFortnox: false },
      { openPayload: openJson, resolveConsent: resolve })).fortnox).toBe('skipped')
    expect(resolve).not.toHaveBeenCalled()

    const failing = fake(companyTables({ unstamped: 1, consents: ['c-1'] }))
    const collection = await collectFortnoxRecords(failing.client, COMPANY, { fetchFromFortnox: true }, {
      openPayload: openJson,
      resolveConsent: vi.fn().mockResolvedValue({ consent: {}, accessToken: 'tok' }),
      fetchMigrationPage: vi.fn().mockRejectedValue(new Error('socket hang up')),
    })
    expect(collection).toMatchObject({ fortnox: 'failed', fortnoxError: 'socket hang up' })
  })

  it('counts a stored payload that cannot be opened instead of failing the company', async () => {
    const { client } = fake(companyTables({ payloads: [raw('1', 'A-1')], stamped: ['1'] }))
    const collection = await collectFortnoxRecords(client, COMPANY, { fetchFromFortnox: false }, {
      openPayload: () => { throw new Error('bad tag') },
    })
    expect(collection).toMatchObject({ unreadable: 1, stored: 0 })
  })
})

describe('repairBlocker', () => {
  const base = { companyId: COMPANY, stored: 1, fetched: 0, unreadable: 0, uncovered: 0, fortnox: 'not_needed' as const }
  const record = (invoiceNumber: string | null): FortnoxNumberRecord => ({
    given_number: '1', invoice_number: invoiceNumber, invoice_date: '2026-06-01', total: 1, currency: 'SEK',
    is_credit_note: false, source: 'stored_payload',
  })

  it('stops a company whose records carry no InvoiceNumber at all: the field name would be wrong', () => {
    expect(repairBlocker({ ...base, records: [record(null), record(' ')], invoiceNumberSeen: false })).toBe('field_missing')
  })

  it('stops a company with no records and lets one through that has a supplier number', () => {
    expect(repairBlocker({ ...base, records: [], invoiceNumberSeen: false })).toBe('no_records')
    expect(repairBlocker({ ...base, records: [record('A-1'), record(null)], invoiceNumberSeen: true })).toBeNull()
  })
})

describe('applyFortnoxNumberRepair', () => {
  const records: FortnoxNumberRecord[] = ['1', '2', '3'].map((given) => ({
    given_number: given, invoice_number: `A-${given}`, invoice_date: '2026-06-01', total: 1, currency: 'SEK',
    is_credit_note: false, source: 'stored_payload',
  }))

  it('sends the whole company in one RPC call, so the reused-number rule sees every record', async () => {
    const { client, rpcArgs } = fake({
      [RPC]: {
        data: {
          counts: { corrected: 2, reused_number: 1 },
          rows: records.map((r, i) => ({ given_number: r.given_number, outcome: i === 2 ? 'reused_number' : 'corrected' })),
          correlation_id: null,
        },
      },
    })
    const result = await applyFortnoxNumberRepair(client, COMPANY, records, { dryRun: true })
    expect(rpcArgs()).toHaveLength(1)
    expect(rpcArgs()[0]).toMatchObject({ p_company_id: COMPANY, p_dry_run: true, p_actor: null, p_rows: records })
    expect(result.counts).toEqual({ corrected: 2, reused_number: 1 })
    expect(result.rows).toHaveLength(3)
  })

  it('passes the actor and one correlation id on a write, and refuses a write without an actor', async () => {
    const { client, rpcArgs } = fake({ [RPC]: { data: { counts: {}, rows: [], correlation_id: 'corr-1' } } })
    const actor = { type: 'user' as const, id: 'user-1', label: 'test' }
    const result = await applyFortnoxNumberRepair(client, COMPANY, records, { dryRun: false, actor, correlationId: 'corr-1' })
    expect(rpcArgs()[0]).toMatchObject({ p_dry_run: false, p_actor: actor, p_correlation_id: 'corr-1' })
    expect(result.correlationId).toBe('corr-1')
    await expect(applyFortnoxNumberRepair(client, COMPANY, records, { dryRun: false })).rejects.toThrow('actor')
  })

  it('surfaces an RPC error', async () => {
    const { client } = fake({ [RPC]: { error: { message: 'company is a migration-reset source' } } })
    await expect(applyFortnoxNumberRepair(client, COMPANY, records, { dryRun: true }))
      .rejects.toThrow('migration-reset source')
  })
})

describe('repairFortnoxSupplierNumbers', () => {
  it('leaves a migration-reset source company alone without collecting anything', async () => {
    const { client, rpcArgs } = fake(companyTables({ frozen: true, payloads: [raw('1', 'A-1')] }))
    const result = await repairFortnoxSupplierNumbers(client, COMPANY, { dryRun: true, fetchFromFortnox: false },
      { openPayload: openJson })
    expect(result.status).toBe('frozen')
    expect(rpcArgs()).toEqual([])
  })

  it('never sends a company whose records carry no InvoiceNumber to the RPC', async () => {
    const { client, rpcArgs } = fake(companyTables({ payloads: [raw('1', undefined), raw('2', '')], stamped: ['1', '2'] }))
    const result = await repairFortnoxSupplierNumbers(client, COMPANY, { dryRun: true, fetchFromFortnox: false },
      { openPayload: openJson })
    expect(result.status).toBe('field_missing')
    expect(rpcArgs()).toEqual([])
  })

  it('dry-runs the collected records', async () => {
    const { client, rpcArgs } = fake({
      ...companyTables({ payloads: [raw('1', 'A-1')], stamped: ['1'] }),
      [RPC]: { data: { counts: { corrected: 1 }, rows: [], correlation_id: null } },
    })
    const result = await repairFortnoxSupplierNumbers(client, COMPANY, { dryRun: true, fetchFromFortnox: false },
      { openPayload: openJson })
    expect(result).toMatchObject({ status: 'dry_run', counts: { corrected: 1 } })
    expect(rpcArgs()[0]).toMatchObject({ p_dry_run: true, p_actor: null })
  })
})

describe('revertFortnoxNumberRepair', () => {
  const REVERT = 'rpc:revert_fortnox_supplier_invoice_numbers'
  const revertArgs = (mock: ReturnType<typeof createTableMockSupabase>) =>
    mock.findCalls(REVERT, 'rpc').map(([args]) => args as Record<string, unknown>)

  it('dry-runs one company and one run without an actor', async () => {
    const mock = createTableMockSupabase({
      [REVERT]: { data: { counts: { reverted: 2, changed_since: 1 }, rows: [], correlation_id: null } },
    })
    const result = await revertFortnoxNumberRepair(mock.supabase as unknown as SupabaseClient, COMPANY, 'run-1', { dryRun: true })
    expect(revertArgs(mock)).toEqual([{ p_company_id: COMPANY, p_correlation_id: 'run-1', p_actor: null, p_dry_run: true }])
    expect(result).toEqual({ counts: { reverted: 2, changed_since: 1 }, rows: [], correlationId: null })
  })

  it('passes the actor on a write, refuses a write without one, and surfaces an RPC error', async () => {
    const mock = createTableMockSupabase({ [REVERT]: [
      { data: { counts: { reverted: 1 }, rows: [], correlation_id: 'revert-1' } },
      { error: { message: 'company is a migration-reset source' } },
    ] })
    const client = mock.supabase as unknown as SupabaseClient
    const actor = { type: 'user' as const, id: 'user-1' }
    const written = await revertFortnoxNumberRepair(client, COMPANY, 'run-1', { dryRun: false, actor })
    expect(revertArgs(mock)[0]).toMatchObject({ p_dry_run: false, p_actor: actor })
    expect(written.correlationId).toBe('revert-1')
    await expect(revertFortnoxNumberRepair(client, COMPANY, 'run-1', { dryRun: false })).rejects.toThrow('actor')
    await expect(revertFortnoxNumberRepair(client, COMPANY, 'run-1', { dryRun: true })).rejects.toThrow('migration-reset source')
  })

  it('finds the companies a run changed, once each', async () => {
    const mock = createTableMockSupabase({
      processing_history: { data: [{ company_id: 'a' }, { company_id: 'b' }, { company_id: 'a' }] },
    })
    expect(await correctedCompanies(mock.supabase as unknown as SupabaseClient, 'run-1')).toEqual(['a', 'b'])
    expect(mock.findCalls('processing_history', 'eq')).toEqual([
      ['correlation_id', 'run-1'], ['event_type', 'SupplierInvoiceNumberCorrected'],
    ])
  })
})
