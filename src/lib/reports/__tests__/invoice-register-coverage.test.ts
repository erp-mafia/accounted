import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import {
  fetchInvoiceRegisterCoverage,
  hasPreRegisterArInPeriod,
  INVOICE_ENGINE_SOURCE_TYPES,
  NO_INVOICE_REGISTER_COVERAGE,
} from '../invoice-register-coverage'

// One read, get_invoice_register_coverage, answered from `tables` by its JS
// port (tests/reskontra-rpc-port.ts). The SQL itself is pinned in
// tests/pg/reskontra-population-rpc.pg.test.ts.
let tables: ReskontraTables
let failures: Record<string, { message: string }>
const { supabase: client, calls } = createReskontraClient(() => tables, () => failures)

const coverageArgs = () => calls.find((c) => c.name === 'get_invoice_register_coverage')?.args

/** An invoice of the register: sent, unlinked and without lines unless told. */
function invoice(id: string, invoiceDate: string, fields: Record<string, unknown> = {}) {
  return { id, invoice_date: invoiceDate, status: 'sent', journal_entry_id: null, ...fields }
}

/** A posted verifikat debiting `account` (1510 unless told) on `date`. */
function verifikat(id: string, date: string, fields: { source_type?: string; account?: string; credit?: boolean; fiscal_period_id?: string } = {}) {
  return {
    journal_entries: [{ id, entry_date: date, status: 'posted', source_type: fields.source_type ?? 'manual', fiscal_period_id: fields.fiscal_period_id ?? 'period-1' }],
    journal_entry_lines: [
      { journal_entry_id: id, account_number: fields.account ?? '1510', debit_amount: fields.credit ? 0 : 1250, credit_amount: fields.credit ? 1250 : 0 },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  tables = {}
  failures = {}
})

describe('fetchInvoiceRegisterCoverage', () => {
  it('returns no coverage when the register is empty', async () => {
    // Drafts and proformas are not the register: a backdated draft would
    // suppress the disclosure for exactly the period it exists to cover.
    tables = {
      invoices: [
        invoice('draft', '2026-01-01', { status: 'draft' }),
        invoice('proforma', '2026-01-01', { document_type: 'proforma' }),
      ],
      ...verifikat('je-1', '2025-12-01'),
    }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual(NO_INVOICE_REGISTER_COVERAGE)
  })

  it('flags pre-register invoices when a posted non-engine AR debit predates the first invoice', async () => {
    tables = { invoices: [invoice('inv-1', '2026-07-19')], ...verifikat('je-1', '2026-07-01') }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-07-19', has_pre_register_invoices: true })
    // The receivable accounts by role, every invoice-engine source type
    // (storno and correction included: a rättelse can be re-dated before the
    // boundary), and the caller's today.
    expect(coverageArgs()).toEqual({
      p_company_id: 'company-1',
      p_ar_accounts: ['1510', '1513'],
      p_engine_source_types: [...INVOICE_ENGINE_SOURCE_TYPES],
      p_today: '2026-10-09',
      p_fiscal_period_id: null,
    })
  })

  it('reads an AR credit, an engine verifikat and an entry on the boundary as no evidence', async () => {
    // An advance payment crediting 1510 before the first invoice says nothing
    // about register-external invoices, nor does the engine's own booking.
    tables = {
      invoices: [invoice('inv-1', '2026-07-19')],
      journal_entries: [
        ...verifikat('je-credit', '2026-07-01', { credit: true }).journal_entries,
        ...verifikat('je-engine', '2026-07-02', { source_type: 'storno' }).journal_entries,
        ...verifikat('je-on-day', '2026-07-19').journal_entries,
      ],
      journal_entry_lines: [
        ...verifikat('je-credit', '2026-07-01', { credit: true }).journal_entry_lines,
        ...verifikat('je-engine', '2026-07-02', { source_type: 'storno' }).journal_entry_lines,
        ...verifikat('je-on-day', '2026-07-19').journal_entry_lines,
      ],
    }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual({ covers_from: '2026-07-19', has_pre_register_invoices: false })
  })

  it('degrades to UNKNOWN when the read errors, never to a confident "complete"', async () => {
    tables = { invoices: [invoice('inv-1', '2026-07-19')] }
    failures = { get_invoice_register_coverage: { message: 'statement timeout' } }

    // { covers_from: '2026-07-19', has_pre_register_invoices: false } here
    // would tell an agent the register is complete on the strength of a
    // failed query: the exact double-invoicing incident this module exists
    // to prevent.
    expect(await fetchInvoiceRegisterCoverage(client, 'company-1')).toEqual(NO_INVOICE_REGISTER_COVERAGE)
  })
})

/**
 * gnubok_register_booked_invoice (crm#1094) registers only the open items of
 * an older reskontra: linked to the verifikat that booked them, no lines. A
 * paid invoice of the same months is still only a verifikat, so those
 * registrations must not pull the boundary back over that period.
 */
describe('fetchInvoiceRegisterCoverage: invoices registered from the books', () => {
  const registration = invoice('reg-1', '2025-11-15', { journal_entry_id: 'je-sie-1' })

  it('starts the boundary at the first invoice the register holds the whole history of', async () => {
    tables = {
      invoices: [registration, invoice('inv-lines', '2026-10-01', { journal_entry_id: 'je-2' })],
      invoice_items: [{ id: 'item-1', invoice_id: 'inv-lines' }],
      ...verifikat('je-sie-1', '2025-11-15', { source_type: 'import' }),
    }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-10-01', has_pre_register_invoices: true })
  })

  it('takes an unlinked invoice (kontantmetoden, deferred booking) as complete history too', async () => {
    tables = {
      invoices: [
        registration,
        invoice('inv-unlinked', '2026-02-01'),
        invoice('inv-lines', '2026-03-01', { journal_entry_id: 'je-2' }),
      ],
      invoice_items: [{ id: 'item-1', invoice_id: 'inv-lines' }],
    }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage.covers_from).toBe('2026-02-01')
  })

  it('discloses everything before today when the register holds only registrations', async () => {
    tables = { invoices: [registration], ...verifikat('je-sie-1', '2025-11-15', { source_type: 'import' }) }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-10-09', has_pre_register_invoices: true })
  })

  it('keeps a first invoice with lines as the boundary, linked or not', async () => {
    tables = {
      invoices: [invoice('inv-1', '2026-07-19', { journal_entry_id: 'je-1' })],
      invoice_items: [{ id: 'item-1', invoice_id: 'inv-1' }],
      ...verifikat('je-0', '2026-07-01'),
    }

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-07-19', has_pre_register_invoices: true })
  })
})

describe('hasPreRegisterArInPeriod', () => {
  it('requires pre-register AR activity inside the given period', async () => {
    tables = { invoices: [invoice('inv-1', '2026-07-19')], ...verifikat('je-1', '2026-07-01', { fiscal_period_id: 'period-0' }) }

    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(false)
    expect(coverageArgs()).toMatchObject({ p_fiscal_period_id: 'period-1' })
  })

  it('is true when flagged activity exists inside the period', async () => {
    tables = { invoices: [invoice('inv-1', '2026-07-19')], ...verifikat('je-1', '2026-07-01') }

    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(true)
  })

  it('is false when the company is not flagged, or the read fails', async () => {
    tables = { invoices: [invoice('inv-1', '2026-01-02')] }
    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(false)

    tables = { invoices: [invoice('inv-1', '2026-07-19')], ...verifikat('je-1', '2026-07-01') }
    failures = { get_invoice_register_coverage: { message: 'statement timeout' } }
    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(false)
  })
})

describe('INVOICE_ENGINE_SOURCE_TYPES', () => {
  // Maintenance guard (Swedish compliance review, PR #2122): every source_type
  // the invoice engine and its correction paths write must be excluded from
  // the pre-register probe, or the engine's own AR debits would be read as
  // evidence of register-external invoices. Scans the writers instead of
  // trusting the list.
  it('covers every source_type the invoice engine writes', () => {
    const writers = [
      'lib/bookkeeping/invoice-entries.ts',
      'lib/bookkeeping/rot-rut-entries.ts',
      'lib/core/bookkeeping/storno-service.ts',
    ]
    const written = new Set<string>()
    for (const rel of writers) {
      const src = readFileSync(join(process.cwd(), 'src', rel), 'utf8')
      for (const m of src.matchAll(/source_type: '([a-z_]+)'/g)) written.add(m[1])
    }
    expect(written.size).toBeGreaterThan(0)
    const missing = [...written].filter(
      (t) => !(INVOICE_ENGINE_SOURCE_TYPES as readonly string[]).includes(t),
    )
    expect(missing).toEqual([])
  })
})
