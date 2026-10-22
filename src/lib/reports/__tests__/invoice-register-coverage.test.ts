import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchInvoiceRegisterCoverage,
  hasPreRegisterArInPeriod,
  INVOICE_ENGINE_SOURCE_TYPES,
  NO_INVOICE_REGISTER_COVERAGE,
} from '../invoice-register-coverage'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('fetchInvoiceRegisterCoverage', () => {
  beforeEach(() => {
    reset()
  })

  it('returns no coverage when the register is empty, without probing the journal', async () => {
    enqueue({ data: null, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual(NO_INVOICE_REGISTER_COVERAGE)
    expect(findCall('journal_entries', 'select')).toBeUndefined()
    // Drafts must not anchor the boundary: a backdated draft would suppress
    // the disclosure for exactly the period it exists to cover.
    expect(findCall('invoices', 'neq')).toEqual(['status', 'draft'])
    expect(findCalls('invoices', 'eq')).toContainEqual(['document_type', 'invoice'])
  })

  it('flags pre-register invoices when a posted non-engine AR debit predates the first invoice', async () => {
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual({
      covers_from: '2026-07-19',
      has_pre_register_invoices: true,
    })
    // Driven from journal_entries (company-indexed), never from the lines
    // table with entry filters on an embed (the lateral-scan shape
    // lib/bookkeeping/entry-lines.ts exists to prevent).
    const eqCalls = findCalls('journal_entries', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['status', 'posted'])
    expect(findCall('journal_entries', 'lt')).toEqual(['entry_date', '2026-07-19'])
    // Every invoice-engine source type is excluded, storno/correction
    // included (a rättelse can be re-dated before the boundary).
    expect(findCall('journal_entries', 'not')).toEqual([
      'source_type',
      'in',
      '("invoice_created","invoice_paid","invoice_cash_payment","credit_note","reminder_fee","rot_rut_payout","rot_rut_reclaim","customer_loss","counterparty_setoff","rot_rut_reclassification","storno","correction")',
    ])
    // AR-scoped and DEBIT-only: an advance payment crediting 1510 before the
    // first invoice is not evidence of register-external invoices.
    expect(findCall('journal_entries', 'in')).toEqual([
      'journal_entry_lines.account_number',
      ['1510', '1513'],
    ])
    expect(findCall('journal_entries', 'gt')).toEqual([
      'journal_entry_lines.debit_amount',
      0,
    ])
  })

  it('reports full coverage when no AR debit predates the first invoice', async () => {
    enqueue({ data: { invoice_date: '2026-01-02' }, error: null })
    enqueue({ data: null, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual({
      covers_from: '2026-01-02',
      has_pre_register_invoices: false,
    })
  })

  it('degrades to UNKNOWN when the AR probe errors, never to a confident "complete"', async () => {
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: null, error: { message: 'statement timeout' } })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    // { covers_from: '2026-07-19', has_pre_register_invoices: false } here
    // would tell an agent the register is complete on the strength of a
    // failed query: the exact double-invoicing incident this module exists
    // to prevent.
    expect(coverage).toEqual(NO_INVOICE_REGISTER_COVERAGE)
  })

  it('degrades to UNKNOWN when the register lookup errors', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual(NO_INVOICE_REGISTER_COVERAGE)
  })
})

/**
 * gnubok_register_booked_invoice (crm#1094) registers only the open items of
 * an older reskontra: linked to the verifikat that booked them, no lines. A
 * paid invoice of the same months is still only a verifikat, so those
 * registrations must not pull the boundary back over that period.
 */
describe('fetchInvoiceRegisterCoverage: invoices registered from the books', () => {
  beforeEach(() => {
    reset()
  })

  const registration = { invoice_date: '2025-11-15', journal_entry_id: 'je-sie-1', invoice_items: [] }

  it('starts the boundary at the first invoice the register holds the whole history of', async () => {
    enqueue({ data: registration, error: null })
    // The earliest unlinked invoice, then the earliest with lines.
    enqueue({ data: null, error: null })
    enqueue({ data: { invoice_date: '2026-10-01', invoice_items: [{ id: 'item-1' }] }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-10-01', has_pre_register_invoices: true })
    expect(findCall('invoices', 'is')).toEqual(['journal_entry_id', null])
    expect(findCalls('invoices', 'select')).toContainEqual(['invoice_date, invoice_items!inner(id)'])
    expect(findCall('journal_entries', 'lt')).toEqual(['entry_date', '2026-10-01'])
  })

  it('takes an unlinked invoice (kontantmetoden, deferred booking) as complete history too', async () => {
    enqueue({ data: registration, error: null })
    enqueue({ data: { invoice_date: '2026-02-01' }, error: null })
    enqueue({ data: { invoice_date: '2026-03-01', invoice_items: [{ id: 'item-1' }] }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage.covers_from).toBe('2026-02-01')
  })

  it('discloses everything before today when the register holds only registrations', async () => {
    enqueue({ data: registration, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-10-09', has_pre_register_invoices: true })
  })

  it('degrades to UNKNOWN when the boundary lookup fails', async () => {
    enqueue({ data: registration, error: null })
    enqueue({ data: null, error: { message: 'statement timeout' } })
    enqueue({ data: null, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual(NO_INVOICE_REGISTER_COVERAGE)
  })

  it('keeps a first invoice with lines as the boundary, linked or not', async () => {
    enqueue({ data: { invoice_date: '2026-07-19', journal_entry_id: 'je-1', invoice_items: [{ id: 'item-1' }] }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1', { today: '2026-10-09' })

    expect(coverage).toEqual({ covers_from: '2026-07-19', has_pre_register_invoices: true })
    expect(findCall('invoices', 'is')).toBeUndefined()
  })
})

describe('hasPreRegisterArInPeriod', () => {
  beforeEach(() => {
    reset()
  })

  it('requires pre-register AR activity inside the given period', async () => {
    // Coverage lookups: first invoice + global probe (flagged) ...
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })
    // ... then the period-scoped probe finds nothing in THIS period.
    enqueue({ data: null, error: null })

    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(false)
    const eqCalls = findCalls('journal_entries', 'eq')
    expect(eqCalls).toContainEqual(['fiscal_period_id', 'period-1'])
  })

  it('is true when flagged activity exists inside the period', async () => {
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: { id: 'entry-1' }, error: null })

    expect(await hasPreRegisterArInPeriod(client, 'company-1', 'period-1')).toBe(true)
  })

  it('skips the period probe entirely when the company is not flagged', async () => {
    enqueue({ data: { invoice_date: '2026-01-02' }, error: null })
    enqueue({ data: null, error: null })

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
