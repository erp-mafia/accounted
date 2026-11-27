/**
 * reverseEntry with the real reversal hooks of the three registers a plain
 * storno used to leave behind: a supplier invoice's registration, a customer
 * invoice's verifikat and a booked salary run's. Each case is a door or a
 * module flow that reaches reverseEntry (lib/composition/reversal-hooks.ts):
 *   - a generic storno (Vänd, v1 reverse, MCP, the bank row's Ångra) of a
 *     registration whose invoice is unpaid posts and puts the invoice back to
 *     not booked; with a payment it is refused before anything is written;
 *   - the supplier invoice create flow undoing a failed registration stornos
 *     a registration the invoice never pointed at: it passes, no invoice moves;
 *   - Ångra kreditering and a failed credit storno the credit note's
 *     verifikat (supplier_credit_note): no supplier invoice hook runs;
 *   - a generic storno of a sent or paid customer invoice's verifikat is
 *     refused; of a draft one's it passes;
 *   - a generic storno of a booked run's verifikat is refused; Korrigera
 *     lönekörning's own (salaryRunCorrection) passes, and so does the storno
 *     of a stray voucher of a run that is not booked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntrySourceType } from '@/types'

vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn(async () => []) } }))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({ backfillStandardBASAccounts: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_s: unknown, _c: unknown, original: { entry_date: string; fiscal_period_id: string }) => ({
    date: original.entry_date,
    fiscal_period_id: original.fiscal_period_id,
    moved: false,
  })),
}))

import { reverseEntry } from '../engine'
import {
  BookedSalaryRunStornoError,
  IssuedInvoiceStornoError,
  SupplierInvoiceRegistrationHasPaymentsError,
} from '../errors'

type Row = Record<string, unknown>

const CHART = ['1930', '2440', '3001', '4010', '7010'].map((n) => ({ id: `acc-${n}`, account_number: n }))

function originalOf(sourceType: JournalEntrySourceType, sourceId: string) {
  return {
    id: 'entry-1',
    company_id: 'company-1',
    user_id: 'user-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-03-10',
    description: 'Original',
    notes: null,
    source_type: sourceType,
    source_id: sourceId,
    correction_of_id: null,
    reverses_id: null,
    lines: [
      { account_number: '4010', debit_amount: 100, credit_amount: 0, line_description: 'Cost' },
      { account_number: '2440', debit_amount: 0, credit_amount: 100, line_description: 'Payable' },
    ],
  }
}

/**
 * A client that walks the storno with register tables answered from rows
 * (eq and in filters applied), and records every table read and every write
 * with the rows its filters match.
 */
function clientFor(original: ReturnType<typeof originalOf>, tables: Record<string, Row[]>) {
  const reads: string[] = []
  const writes: Array<{ table: string; op: string; payload: unknown; matched: string[] }> = []
  let journalReads = 0

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: unknown
    const filters: Array<(row: Row) => boolean> = []
    const b: Record<string, unknown> = {}
    const write = (kind: 'insert' | 'update' | 'delete') => (p?: unknown) => {
      op = kind
      payload = p
      return b
    }
    b.insert = write('insert')
    b.update = write('update')
    b.delete = write('delete')
    b.select = () => b
    b.eq = (column: string, value: unknown) => {
      filters.push((row) => row[column] === value)
      return b
    }
    b.in = (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]))
      return b
    }
    for (const m of ['neq', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit']) b[m] = () => b
    const matching = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
    const resolve = (one: boolean) => {
      if (table === 'journal_entries') {
        if (op === 'insert') return { data: { id: 'reversal-1', status: 'draft', ...(payload as object) }, error: null }
        if (op === 'update') {
          const status = (payload as { status?: string } | undefined)?.status
          return status === 'reversed' ? { data: [{ id: original.id }], error: null } : { data: null, error: null }
        }
        journalReads++
        if (journalReads === 1) return { data: original, error: null }
        return { data: { id: `read-${journalReads}`, status: 'posted', lines: [] }, error: null }
      }
      if (table === 'chart_of_accounts') return { data: CHART, error: null }
      if (op !== 'select') {
        writes.push({ table, op, payload, matched: matching().map((row) => String(row.id)) })
        return { data: null, error: null }
      }
      if (table in tables) reads.push(table)
      const rows = matching()
      return { data: one ? (rows[0] ?? null) : rows, error: null }
    }
    b.single = async () => resolve(true)
    b.maybeSingle = async () => resolve(true)
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(false)).then(onFulfilled, onRejected)
    return b
  }

  const supabase = {
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (name: string) => {
      if (name === 'release_reversed_entry_transactions') return { data: { released: 0, dropped: 0 }, error: null }
      return { data: null, error: null }
    }),
  }
  const committed = () => supabase.rpc.mock.calls.some(([name]) => name === 'commit_journal_entry')
  const registerWrites = () => writes.filter((w) => w.table in tables)
  return { supabase, reads, writes, committed, registerWrites }
}

beforeEach(() => vi.clearAllMocks())

describe('a supplier invoice registration verifikat', () => {
  const invoice = (overrides: Row = {}) => ({
    id: 'si-1',
    company_id: 'company-1',
    registration_journal_entry_id: 'entry-1',
    status: 'approved',
    paid_amount: 0,
    ...overrides,
  })

  it('generic storno of an unpaid invoice: posts, and the invoice reads not booked', async () => {
    const c = clientFor(originalOf('supplier_invoice_registered', 'si-1'), {
      supplier_invoices: [invoice()],
      supplier_invoice_payments: [],
    })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toBeTruthy()
    expect(c.committed()).toBe(true)
    expect(c.registerWrites()).toEqual([
      { table: 'supplier_invoices', op: 'update', payload: { registration_journal_entry_id: null }, matched: ['si-1'] },
    ])
  })

  it('generic storno while the invoice has a payment: refused before anything is written', async () => {
    const c = clientFor(originalOf('supplier_invoice_registered', 'si-1'), {
      supplier_invoices: [invoice({ status: 'partially_paid' })],
      supplier_invoice_payments: [{ id: 'pay-1', company_id: 'company-1', supplier_invoice_id: 'si-1' }],
    })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      SupplierInvoiceRegistrationHasPaymentsError,
    )
    expect(c.supabase.rpc).not.toHaveBeenCalled()
    expect(c.writes).toEqual([])
  })

  it('the create flow undoing a failed registration: the invoice never pointed at it, so it passes and no invoice moves', async () => {
    // undoFailedRegistration (lib/supplier-invoices/create.ts) stornos the
    // registration before the link was written (or after the link failed).
    const c = clientFor(originalOf('supplier_invoice_registered', 'si-1'), {
      supplier_invoices: [invoice({ registration_journal_entry_id: null, status: 'registered' })],
      supplier_invoice_payments: [],
    })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toBeTruthy()
    expect(c.committed()).toBe(true)
    expect(c.registerWrites()).toEqual([
      { table: 'supplier_invoices', op: 'update', payload: { registration_journal_entry_id: null }, matched: [] },
    ])
  })

  it('a credit note verifikat (Ångra kreditering, a failed credit): no supplier invoice hook runs', async () => {
    const c = clientFor(originalOf('supplier_credit_note', 'si-credit-1'), {
      supplier_invoices: [invoice({ id: 'si-credit-1', registration_journal_entry_id: 'entry-1', status: 'credited' })],
      supplier_invoice_payments: [],
    })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toBeTruthy()
    expect(c.reads).toEqual([])
    expect(c.registerWrites()).toEqual([])
  })
})

describe('a customer invoice verifikat', () => {
  const invoice = (status: string) => ({ id: 'inv-1', company_id: 'company-1', journal_entry_id: 'entry-1', status })

  it.each(['sent', 'paid'])('generic storno of a %s invoice: refused before anything is written', async (status) => {
    const c = clientFor(originalOf('invoice_created', 'inv-1'), { invoices: [invoice(status)] })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      IssuedInvoiceStornoError,
    )
    expect(c.supabase.rpc).not.toHaveBeenCalled()
    expect(c.writes).toEqual([])
  })

  it('generic storno of a draft invoice\'s verifikat: passes, the invoice is not written', async () => {
    const c = clientFor(originalOf('invoice_created', 'inv-1'), { invoices: [invoice('draft')] })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toBeTruthy()
    expect(c.registerWrites()).toEqual([])
  })
})

describe('a salary run verifikat', () => {
  const run = (status: string) => ({
    id: 'run-1',
    company_id: 'company-1',
    status,
    salary_entry_id: 'entry-1',
    avgifter_entry_id: 'entry-2',
    vacation_entry_id: null,
    pension_entry_id: null,
  })

  it('generic storno of a booked run\'s verifikat: refused before anything is written', async () => {
    const c = clientFor(originalOf('salary_payment', 'run-1'), { salary_runs: [run('booked')] })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      BookedSalaryRunStornoError,
    )
    expect(c.supabase.rpc).not.toHaveBeenCalled()
    expect(c.writes).toEqual([])
  })

  it('Korrigera lönekörning (salaryRunCorrection): its storno of the booked run passes, the run is not read', async () => {
    const c = clientFor(originalOf('salary_payment', 'run-1'), { salary_runs: [run('booked')] })
    await expect(
      reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1', undefined, { salaryRunCorrection: true }),
    ).resolves.toBeTruthy()
    expect(c.committed()).toBe(true)
    expect(c.reads).toEqual([])
  })

  it('a stray voucher of an interrupted booking (the run still paid): passes', async () => {
    const c = clientFor(originalOf('salary_payment', 'run-1'), { salary_runs: [run('paid')] })
    await expect(reverseEntry(c.supabase as never, 'company-1', 'user-1', 'entry-1')).resolves.toBeTruthy()
    expect(c.reads).toEqual(['salary_runs'])
  })
})
