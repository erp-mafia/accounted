/**
 * Tests for lib/vat/filed-period-changes.ts: what moved a filed
 * momsdeklaration after it was filed. The ledger reads are answered per
 * table (createTableMockSupabase), so each test states what the database
 * holds, not the order the module asks in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import type { VatFilingRecord } from '@/lib/vat/filing-record'

vi.mock('@/lib/reports/vat-revenue-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/vat-revenue-accounts')>()),
  fetchDynamicVatAccounts: vi.fn(async () => ({
    accounts: [],
    unconfiguredRevenueAccounts: new Map(),
    unconfiguredVatAccounts: new Map(),
    rateByAccount: new Map(),
    staticRateByAccount: new Map(),
    mappingByAccount: new Map(),
    explicitAccounts: new Set(),
  })),
}))

const store = vi.hoisted(() => ({ listVatFilings: vi.fn() }))
vi.mock('@/lib/vat/filing-record-store', () => store)

import {
  baselineAfterImports,
  filingBaseline,
  listVatFilingsWithChanges,
  withChangesAfterFiling,
} from '../filed-period-changes'

const COMPANY = 'company-1'

const JULY: VatFilingRecord = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  period_type: 'monthly',
  year: 2026,
  period: 7,
  tax_period: '2026-07',
  period_start: '2026-07-01',
  period_end: '2026-07-31',
  filed_on: '2026-08-10',
  source: 'manual',
  reference: null,
}

type Entry = {
  id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  source_type: string
  status: string
  committed_at: string | null
  created_at: string
  import_batch_id: string | null
}

const entry = (overrides: Partial<Entry> & Pick<Entry, 'id' | 'voucher_number' | 'committed_at'>): Entry => ({
  voucher_series: 'A',
  entry_date: '2026-07-20',
  source_type: 'manual',
  status: 'posted',
  created_at: overrides.committed_at ?? '2026-07-20T10:00:00Z',
  import_batch_id: null,
  ...overrides,
})

const line = (journal_entry_id: string, account_number: string, debit: number, credit: number) => ({
  id: `${journal_entry_id}-${account_number}`,
  journal_entry_id,
  account_number,
  debit_amount: debit,
  credit_amount: credit,
})

/** A sale of 16 952 + 25 % moms booked into July. */
const SALE_LINES = (id: string) => [line(id, '1510', 21190, 0), line(id, '3001', 0, 16952), line(id, '2611', 0, 4238)]

function ledger(opts: {
  late?: Entry[]
  rattelseEntries?: Entry[]
  rattelser?: unknown[]
  lines?: ReturnType<typeof line>[]
  special?: Array<{ journal_entry_id: string; reason: string }>
  deferrals?: Array<{ journal_entry_id: string; target_account: string; share: number }>
  submissions?: Array<{ id: string; key: string; value: unknown }>
  closing?: string[]
}) {
  const lines = opts.lines ?? []
  return createTableMockSupabase({
    extension_data: { data: opts.submissions ?? [] },
    journal_entry_rattelse_log: { data: opts.rattelser ?? [] },
    fiscal_periods: { data: (opts.closing ?? []).map((id) => ({ closing_entry_id: id })) },
    journal_entries: (chain): TableMockResult => {
      const byId = chain.find((c) => c.method === 'in' && c.args[0] === 'id')
      if (byId) {
        const ids = byId.args[1] as string[]
        return { data: (opts.rattelseEntries ?? []).filter((e) => ids.includes(e.id)) }
      }
      return { data: opts.late ?? [] }
    },
    journal_entry_lines: (chain): TableMockResult => {
      const ids = (chain.find((c) => c.method === 'in')?.args[1] ?? []) as string[]
      return { data: lines.filter((l) => ids.includes(l.journal_entry_id)) }
    },
    'rpc:vat_declaration_special_entries': { data: opts.special ?? [] },
    'rpc:vat_invoice_deferral_shares': { data: opts.deferrals ?? [] },
    'rpc:skattekonto_shape_accounts': { data: ['1630'] },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('filingBaseline', () => {
  it('starts after the Stockholm day a hand mark was filed on', () => {
    expect(filingBaseline(JULY)).toBe('2026-08-10T21:59:59Z')
  })

  it('never starts before the period has ended (an old mark dated inside it)', () => {
    expect(filingBaseline({ ...JULY, filed_on: '2026-07-15' })).toBe('2026-07-31T21:59:59Z')
  })

  it('takes the exact instant of a later signing through the connection (a corrected declaration)', () => {
    expect(filingBaseline(JULY, '2026-10-05T18:30:43.000Z')).toBe('2026-10-05T18:30:43.000Z')
  })

  it('takes the signing instant on the filed day itself, so a change the next morning counts', () => {
    expect(filingBaseline({ ...JULY, filed_on: '2026-10-03' }, '2026-10-02T22:30:42.837Z')).toBe('2026-10-02T22:30:42.837Z')
  })

  it('keeps the hand mark when it is newer than the connection signing (filed again elsewhere)', () => {
    expect(filingBaseline({ ...JULY, filed_on: '2026-09-20' }, '2026-08-21T14:30:00Z')).toBe('2026-09-20T21:59:59Z')
  })
})

describe('baselineAfterImports', () => {
  it('moves the baseline past the first history import batch after the filing', () => {
    const entries = [
      entry({ id: 'i1', voucher_number: 1, source_type: 'import', import_batch_id: 'b1', committed_at: '2026-09-01T10:00:00Z' }),
      entry({ id: 'i2', voucher_number: 2, source_type: 'import', import_batch_id: 'b1', committed_at: '2026-09-01T10:05:00Z' }),
      entry({ id: 'i3', voucher_number: 3, source_type: 'import', import_batch_id: 'b2', committed_at: '2026-09-03T09:00:00Z' }),
    ]
    expect(baselineAfterImports(entries, '2026-08-10T21:59:59Z')).toBe('2026-09-01T10:05:00Z')
  })

  it('keeps the baseline when no history was imported after it', () => {
    const entries = [entry({ id: 'm1', voucher_number: 1, committed_at: '2026-09-01T10:00:00Z' })]
    expect(baselineAfterImports(entries, '2026-08-10T21:59:59Z')).toBe('2026-08-10T21:59:59Z')
  })
})

describe('withChangesAfterFiling', () => {
  it('reads nothing for a company with no filings', async () => {
    const mock = ledger({})
    expect(await withChangesAfterFiling(mock.supabase as never, COMPANY, [])).toEqual([])
    expect(mock.calls).toEqual([])
  })

  it('names a verifikat posted into the filed month afterwards, with the rutor it moved', async () => {
    const sale = entry({ id: 'e1', voucher_series: 'B', voucher_number: 2, entry_date: '2026-07-29', source_type: 'invoice_created', committed_at: '2026-10-24T18:29:38Z' })
    const settlement = entry({ id: 'e2', voucher_number: 9, source_type: 'vat_settlement', committed_at: '2026-10-24T19:00:00Z' })
    const shaped = entry({ id: 'e3', voucher_number: 10, committed_at: '2026-10-24T19:05:00Z' })
    const mock = ledger({
      late: [sale, settlement, shaped],
      lines: [...SALE_LINES('e1'), line('e3', '2611', 4238, 0), line('e3', '2650', 0, 4238)],
      special: [{ journal_entry_id: 'e3', reason: 'momsredovisning_shape' }],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing).toEqual({
      changed_after: '2026-08-10T21:59:59Z',
      rutor_change: { ruta05: 16952, ruta10: 4238, ruta49: 4238 },
      verifikat: [
        {
          journal_entry_id: 'e1',
          voucher: 'B2',
          entry_date: '2026-07-29',
          changed_at: '2026-10-24T18:29:38Z',
          kind: 'posted',
          rutor_change: { ruta05: 16952, ruta10: 4238, ruta49: 4238 },
        },
      ],
    })
    expect(mock.findCall('journal_entries', 'gte')).toEqual(['entry_date', '2026-07-01'])
    expect(mock.findCall('journal_entries', 'lte')).toEqual(['entry_date', '2026-07-31'])
    expect(mock.supabase.rpc).toHaveBeenCalledWith('vat_declaration_special_entries', expect.objectContaining({
      p_company_id: COMPANY,
      p_start: '2026-07-01',
      p_end: '2026-07-31',
    }))
  })

  it('counts the periodiserad part of an invoice posted afterwards as sale, with its moms (crm#1919)', async () => {
    const sale = entry({ id: 'e5', voucher_number: 12, entry_date: '2026-07-29', source_type: 'invoice_created', committed_at: '2026-10-24T18:29:38Z' })
    const mock = ledger({
      late: [sale],
      // 4 000 on 3001 and 12 000 periodiserad on 2970, 25 % moms on both.
      lines: [line('e5', '1510', 20000, 0), line('e5', '2970', 0, 12000), line('e5', '3001', 0, 4000), line('e5', '2611', 0, 4000)],
      deferrals: [{ journal_entry_id: 'e5', target_account: '3001', share: 1 }],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing?.rutor_change).toEqual({ ruta05: 16000, ruta10: 4000, ruta49: 4000 })
  })

  it('leaves a release of a periodiserad invoice line out, also when it is moved out of the period (crm#1919)', async () => {
    // Different amounts, so neither can hide the other: read off the
    // accounts alone, the late release adds 2 000 and the moved one takes
    // 3 000 away.
    const release = entry({ id: 'e6', voucher_number: 13, entry_date: '2026-07-01', source_type: 'accrual', committed_at: '2026-10-24T18:29:38Z' })
    const movedOut = entry({ id: 'e7', voucher_number: 14, entry_date: '2026-08-01', source_type: 'accrual', committed_at: '2026-07-01T08:00:00Z' })
    const filed = (deferrals: Array<{ journal_entry_id: string; target_account: string; share: number }>) => ledger({
      late: [release],
      rattelseEntries: [movedOut],
      rattelser: [{
        id: 'r7', journal_entry_id: 'e7', rattelse_type: 'metadata',
        old_entry_date: '2026-07-01', new_entry_date: '2026-08-01',
        struck_lines: null, added_lines: null, created_at: '2026-10-24T19:00:00Z',
      }],
      lines: [line('e6', '2970', 2000, 0), line('e6', '3001', 0, 2000), line('e7', '2970', 3000, 0), line('e7', '3001', 0, 3000)],
      deferrals,
    })

    const [read] = await withChangesAfterFiling(filed([
      { journal_entry_id: 'e6', target_account: '3001', share: 1 },
      { journal_entry_id: 'e7', target_account: '3001', share: 1 },
    ]).supabase as never, COMPANY, [JULY])
    const [unread] = await withChangesAfterFiling(filed([]).supabase as never, COMPANY, [JULY])

    expect(read.changed_after_filing).toBeNull()
    expect(unread.changed_after_filing?.rutor_change).toEqual({ ruta05: -1000 })
  })

  it('moves no ruta when an inline rättelse changes what a release releases (crm#1919)', async () => {
    const release = entry({ id: 'e9', voucher_number: 16, entry_date: '2026-07-01', source_type: 'accrual', committed_at: '2026-07-01T08:00:00Z' })
    const mock = ledger({
      rattelseEntries: [release],
      rattelser: [{
        id: 'r9', journal_entry_id: 'e9', rattelse_type: 'lines',
        old_entry_date: null, new_entry_date: null,
        struck_lines: [
          { account_number: '2970', debit_amount: 2000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 2000 },
        ],
        added_lines: [
          { account_number: '2970', debit_amount: 1500, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1500 },
        ],
        created_at: '2026-09-01T12:00:00Z',
      }],
      lines: [line('e9', '2970', 1500, 0), line('e9', '3001', 0, 1500)],
      deferrals: [{ journal_entry_id: 'e9', target_account: '3001', share: 1 }],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing).toBeNull()
  })

  it('counts the sale an inline rättelse of a release adds, with its moms, and the release still as nothing (crm#1919)', async () => {
    const release = entry({ id: 'e8', voucher_number: 15, entry_date: '2026-07-01', source_type: 'accrual', committed_at: '2026-07-01T08:00:00Z' })
    const mock = ledger({
      rattelseEntries: [release],
      rattelser: [{
        id: 'r8', journal_entry_id: 'e8', rattelse_type: 'lines',
        old_entry_date: null, new_entry_date: null,
        struck_lines: [],
        added_lines: [
          { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
          { account_number: '2611', debit_amount: 0, credit_amount: 250 },
        ],
        created_at: '2026-09-01T12:00:00Z',
      }],
      lines: [
        line('e8', '2970', 2000, 0), line('e8', '3001', 0, 2000),
        line('e8', '1510', 1250, 0), line('e8', '3001', 0, 1000), line('e8', '2611', 0, 250),
      ],
      deferrals: [{ journal_entry_id: 'e8', target_account: '3001', share: 1 }],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing?.rutor_change).toEqual({ ruta05: 1000, ruta10: 250, ruta49: 250 })
  })

  it('leaves the posted bokslut out', async () => {
    const bokslut = entry({ id: 'e4', voucher_number: 11, source_type: 'year_end', committed_at: '2026-10-01T08:00:00Z' })
    const mock = ledger({ late: [bokslut], lines: [line('e4', '3001', 16952, 0), line('e4', '8999', 0, 16952)], closing: ['e4'] })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing).toBeNull()
  })

  it('counts an inline rättelse of a verifikat the filing already read', async () => {
    const purchase = entry({ id: 'e5', voucher_number: 4, entry_date: '2026-07-15', committed_at: '2026-08-01T09:00:00Z' })
    const mock = ledger({
      rattelseEntries: [purchase],
      rattelser: [
        {
          id: 'r1',
          journal_entry_id: 'e5',
          rattelse_type: 'lines',
          old_entry_date: null,
          new_entry_date: null,
          struck_lines: [
            { account_number: '5410', debit_amount: 400, credit_amount: 0 },
            { account_number: '2641', debit_amount: 100, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 500 },
          ],
          added_lines: [
            { account_number: '5410', debit_amount: 500, credit_amount: 0 },
            { account_number: '2641', debit_amount: 125, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 625 },
          ],
          created_at: '2026-09-01T12:00:00Z',
        },
      ],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing?.rutor_change).toEqual({ ruta48: 25, ruta49: -25 })
    expect(record.changed_after_filing?.verifikat).toMatchObject([{ journal_entry_id: 'e5', kind: 'rattelse', voucher: 'A4' }])
  })

  it('does not count a rättelse twice on a verifikat posted after the filing', async () => {
    const late = entry({ id: 'e1', voucher_series: 'B', voucher_number: 2, entry_date: '2026-07-29', committed_at: '2026-10-24T18:29:38Z' })
    const mock = ledger({
      late: [late],
      rattelseEntries: [late],
      lines: SALE_LINES('e1'),
      rattelser: [
        {
          id: 'r2',
          journal_entry_id: 'e1',
          rattelse_type: 'lines',
          old_entry_date: null,
          new_entry_date: null,
          struck_lines: [{ account_number: '2611', debit_amount: 0, credit_amount: 1000 }],
          added_lines: [{ account_number: '2611', debit_amount: 0, credit_amount: 4238 }],
          created_at: '2026-10-25T08:00:00Z',
        },
      ],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing?.rutor_change).toEqual({ ruta05: 16952, ruta10: 4238, ruta49: 4238 })
  })

  it('counts a verifikat re-dated into the filed month', async () => {
    // Posted on the filed day, dated in August, then re-dated into July.
    const moved = entry({ id: 'e6', voucher_number: 87, entry_date: '2026-07-31', committed_at: '2026-08-10T08:00:00Z' })
    const mock = ledger({
      rattelseEntries: [moved],
      lines: [line('e6', '1930', 1250, 0), line('e6', '3001', 0, 1000), line('e6', '2611', 0, 250)],
      rattelser: [
        {
          id: 'r3',
          journal_entry_id: 'e6',
          rattelse_type: 'metadata',
          old_entry_date: '2026-08-09',
          new_entry_date: '2026-07-31',
          struck_lines: null,
          added_lines: null,
          created_at: '2026-08-13T06:51:02Z',
        },
      ],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing?.rutor_change).toEqual({ ruta05: 1000, ruta10: 250, ruta49: 250 })
    expect(record.changed_after_filing?.verifikat).toMatchObject([{ journal_entry_id: 'e6', kind: 'redated' }])
  })

  it('takes a corrected declaration signed through the connection as the latest filing', async () => {
    const sale = entry({ id: 'e1', voucher_series: 'B', voucher_number: 2, entry_date: '2026-07-29', committed_at: '2026-10-24T18:29:38Z' })
    const mock = ledger({
      late: [sale],
      lines: SALE_LINES('e1'),
      submissions: [
        { id: 'x1', key: 'submission_202607', value: JSON.stringify({ status: 'signed', updatedAt: '2026-10-25T10:00:00.000Z' }) },
      ],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing).toBeNull()
  })

  it('treats history imported after the filing as the books as filed', async () => {
    const mock = ledger({
      late: [
        entry({ id: 'i1', voucher_number: 1, source_type: 'import', import_batch_id: 'b1', entry_date: '2026-07-05', committed_at: '2026-09-01T10:00:00Z' }),
        entry({ id: 'e7', voucher_number: 5, entry_date: '2026-07-31', committed_at: '2026-09-02T10:00:00Z' }),
      ],
      lines: [...SALE_LINES('i1'), line('e7', '6110', 800, 0), line('e7', '2641', 200, 0), line('e7', '1930', 0, 1000)],
    })

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record.changed_after_filing).toMatchObject({
      changed_after: '2026-09-01T10:00:00Z',
      rutor_change: { ruta48: 200, ruta49: -200 },
    })
    expect(record.changed_after_filing?.verifikat.map((v) => v.journal_entry_id)).toEqual(['e7'])
  })

  it('keeps the filing list when the changes cannot be read', async () => {
    store.listVatFilings.mockResolvedValue([JULY])
    const mock = ledger({
      late: [entry({ id: 'e1', voucher_number: 2, committed_at: '2026-10-24T18:29:38Z' })],
    })
    mock.setTable('rpc:vat_declaration_special_entries', { data: null, error: { message: 'statement timeout' } })

    const records = await listVatFilingsWithChanges(mock.supabase as never, COMPANY)

    expect(records).toEqual([{ ...JULY, changed_after_filing: null }])
  })

  it('answers null for a filed period nothing touched since', async () => {
    const mock = ledger({})

    const [record] = await withChangesAfterFiling(mock.supabase as never, COMPANY, [JULY])

    expect(record).toEqual({ ...JULY, changed_after_filing: null })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})
