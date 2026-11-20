/**
 * Storno and rättelse of a kontantmetod year-end carry (#3440): the engine
 * refuses by name BEFORE any write, where the database
 * (kontantmetod_carry_on_reversal) would otherwise refuse at the
 * compare-and-set and the user would read "already reversed".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reverseEntry } from '../engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import {
  CutoffCarryCorrectionRefusedError,
  CutoffCarryReversalDateError,
  KontantmetodCarryHasSettlementsError,
} from '../errors'
import {
  findKontantmetodCarry,
  kontantmetodCarryHasSettlements,
} from '../kontantmetod-carry-guard'

type Row = Record<string, unknown>

const CARRY = {
  id: 'carry-1',
  company_id: 'company-1',
  status: 'posted',
  fiscal_period_id: 'fp-2026',
  voucher_series: 'A',
  voucher_number: 90,
  entry_date: '2026-12-31',
  description: 'Kundfaktura F-1: obetald vid bokslut (kontantmetoden)',
  source_type: 'year_end',
  source_id: 'fp-2026',
  reverses_id: null,
  correction_of_id: null,
  lines: [
    { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    { account_number: '2611', debit_amount: 0, credit_amount: 250 },
  ],
}

/**
 * Table-routed mock: every read resolves from `tables`, every write is
 * recorded. Inserts, updates and RPCs are what "before any write" is
 * asserted against.
 */
function makeSupabase(tables: Record<string, Row[] | Row | null>) {
  const writes: string[] = []
  const reads: string[] = []
  const from = vi.fn((table: string) => {
    reads.push(table)
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'neq', 'order', 'limit', 'is', 'gt', 'gte', 'lte']) {
      b[m] = vi.fn().mockReturnValue(b)
    }
    for (const m of ['insert', 'update', 'delete', 'upsert']) {
      b[m] = vi.fn(() => {
        writes.push(`${table}.${m}`)
        return b
      })
    }
    const value = tables[table]
    const list = Array.isArray(value) ? value : value ? [value] : []
    b.single = vi.fn(async () => ({ data: Array.isArray(value) ? value[0] ?? null : value ?? null, error: null }))
    b.maybeSingle = b.single
    b.then = (resolve: (v: unknown) => void) => resolve({ data: list, error: null })
    return b
  })
  const rpc = vi.fn(async (fn: string) => {
    writes.push(`rpc:${fn}`)
    return { data: null, error: { message: 'stop here' } }
  })
  return { supabase: { from, rpc }, writes, reads }
}

const MARKER = { kind: 'receivable_invoice', invoice_id: 'inv-1', supplier_invoice_id: null }

// The storno target check (assertStornoTarget) reads the carry's own open
// period before the engine reaches the voucher allocation.
const OPEN_PERIOD = {
  fiscal_periods: {
    id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
    is_closed: false, locked_at: null,
  },
  company_settings: { lock_date: null },
  // The storno's accounts, resolved before the reversal draft is written.
  chart_of_accounts: [
    { id: 'acc-1510', account_number: '1510', is_active: true },
    { id: 'acc-3001', account_number: '3001', is_active: true },
    { id: 'acc-2611', account_number: '2611', is_active: true },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reverseEntry on a kontantmetod year-end carry', () => {
  it('refuses a storno dated outside the carry\'s own date before any write', async () => {
    const { supabase, writes } = makeSupabase({
      journal_entries: CARRY,
      kontantmetod_cutoff_entries: [MARKER],
      invoice_payments: [],
      invoices: [],
    })
    const err = await reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1', '2027-01-01')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CutoffCarryReversalDateError)
    expect(err).toMatchObject({
      code: 'CUTOFF_CARRY_REVERSAL_DATE',
      carryDate: '2026-12-31',
      reversalDate: '2027-01-01',
    })
    expect(writes).toEqual([])
  })

  it('refuses while the carried invoice has a payment row', async () => {
    const { supabase, writes } = makeSupabase({
      journal_entries: CARRY,
      kontantmetod_cutoff_entries: [MARKER],
      invoice_payments: [{ id: 'pay-1' }],
      invoices: [],
    })
    const err = await reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1', '2026-12-31')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KontantmetodCarryHasSettlementsError)
    expect(err).toMatchObject({ code: 'KONTANTMETOD_CARRY_HAS_SETTLEMENTS', invoiceId: 'inv-1' })
    expect(writes).toEqual([])
  })

  it('refuses while a credit note with a posted verifikat credits the carried invoice', async () => {
    // journal_entries answers both the original read (single) and the
    // credit note verifikat read (list, status posted).
    const { supabase, writes } = makeSupabase({
      journal_entries: [CARRY],
      kontantmetod_cutoff_entries: [MARKER],
      invoice_payments: [],
      invoices: [{ id: 'cn-1', journal_entry_id: 'carry-1' }],
    })
    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1'),
    ).rejects.toBeInstanceOf(KontantmetodCarryHasSettlementsError)
    expect(writes).toEqual([])
  })

  it('lets a storno on the carry\'s own date through to the voucher allocation', async () => {
    const { supabase, writes } = makeSupabase({
      ...OPEN_PERIOD,
      journal_entries: CARRY,
      kontantmetod_cutoff_entries: [MARKER],
      invoice_payments: [],
      invoices: [],
    })
    const err = await reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1', '2026-12-31')
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(CutoffCarryReversalDateError)
    expect(err).not.toBeInstanceOf(KontantmetodCarryHasSettlementsError)
    // The guard let it through: the engine went on to its first write.
    expect(writes[0]).toMatch(/^(rpc:|journal_entries\.insert)/)
  })

  it('applies to the supplier side the same way', async () => {
    const { supabase, writes } = makeSupabase({
      journal_entries: { ...CARRY, description: 'Leverantörsfaktura LF-1' },
      kontantmetod_cutoff_entries: [{ kind: 'payable_invoice', invoice_id: null, supplier_invoice_id: 'si-1' }],
      supplier_invoice_payments: [{ id: 'sp-1' }],
      supplier_invoices: [],
    })
    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1'),
    ).rejects.toMatchObject({ code: 'KONTANTMETOD_CARRY_HAS_SETTLEMENTS', invoiceId: 'si-1' })
    expect(writes).toEqual([])
  })

  it('leaves a year_end entry that is not a carry alone (no marker)', async () => {
    const { supabase, writes } = makeSupabase({
      ...OPEN_PERIOD,
      journal_entries: CARRY,
      kontantmetod_cutoff_entries: [],
    })
    const err = await reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1', '2026-12-30')
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(CutoffCarryReversalDateError)
    expect(writes[0]).toMatch(/^(rpc:|journal_entries\.insert)/)
  })

  it('never reads the marker table for an entry that is not year_end', async () => {
    const { supabase, reads } = makeSupabase({
      journal_entries: { ...CARRY, source_type: 'manual' },
    })
    await reverseEntry(supabase as never, 'company-1', 'user-1', 'carry-1').catch(() => null)
    expect(reads).not.toContain('kontantmetod_cutoff_entries')
  })
})

describe('correctEntry on a kontantmetod year-end carry', () => {
  it('refuses with CUTOFF_CARRY_CORRECTION_REFUSED before any write', async () => {
    const { supabase, writes } = makeSupabase({
      kontantmetod_cutoff_entries: [MARKER],
    })
    const err = await correctEntry(
      supabase as never, 'company-1', 'user-1', 'carry-1',
      [
        { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 800 },
        { account_number: '2611', debit_amount: 0, credit_amount: 200 },
      ],
      { preloadedOriginal: CARRY as never },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CutoffCarryCorrectionRefusedError)
    expect(err).toMatchObject({ code: 'CUTOFF_CARRY_CORRECTION_REFUSED' })
    expect(writes).toEqual([])
  })
})

describe('kontantmetod carry lookups', () => {
  it('reads no carry from a non-per-invoice marker', async () => {
    const { supabase } = makeSupabase({
      kontantmetod_cutoff_entries: [{ kind: 'receivable', invoice_id: null, supplier_invoice_id: null }],
    })
    expect(await findKontantmetodCarry(supabase as never, 'company-1', 'e-1')).toBeNull()
  })

  it('does not count a credit note whose verifikat is not posted', async () => {
    const { supabase } = makeSupabase({
      invoice_payments: [],
      invoices: [{ id: 'cn-1', journal_entry_id: 'je-cn' }],
      journal_entries: [],
    })
    expect(await kontantmetodCarryHasSettlements(supabase as never, 'company-1', {
      entryId: 'carry-1', kind: 'receivable_invoice', invoiceId: 'inv-1', supplierInvoiceId: null,
    })).toBe(false)
  })

  it('fails open on a read error: the database stays the authority', async () => {
    const supabase = {
      from: () => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'limit', 'gt']) b[m] = () => b
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } })
        return b
      },
    }
    expect(await findKontantmetodCarry(supabase as never, 'company-1', 'e-1')).toBeNull()
    expect(await kontantmetodCarryHasSettlements(supabase as never, 'company-1', {
      entryId: 'carry-1', kind: 'receivable_invoice', invoiceId: 'inv-1', supplierInvoiceId: null,
    })).toBe(false)
  })

  it('counts only payments dated after the carry: a closed-year part payment does not hold it', async () => {
    const filters: Array<{ table: string; column: string; value: unknown }> = []
    const supabase = {
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'limit']) b[m] = () => b
        b.gt = (column: string, value: unknown) => {
          filters.push({ table, column, value })
          return b
        }
        b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        return b
      },
    }
    expect(await kontantmetodCarryHasSettlements(supabase as never, 'company-1', {
      entryId: 'carry-1', kind: 'receivable_invoice', invoiceId: 'inv-1', supplierInvoiceId: null,
    }, '2026-12-31')).toBe(false)
    expect(await kontantmetodCarryHasSettlements(supabase as never, 'company-1', {
      entryId: 'carry-2', kind: 'payable_invoice', invoiceId: null, supplierInvoiceId: 'si-1',
    }, '2026-12-31')).toBe(false)
    expect(filters).toEqual([
      { table: 'invoice_payments', column: 'payment_date', value: '2026-12-31' },
      { table: 'supplier_invoice_payments', column: 'payment_date', value: '2026-12-31' },
    ])
  })
})
