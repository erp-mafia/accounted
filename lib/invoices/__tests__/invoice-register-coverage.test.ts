import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  fetchInvoiceRegisterCoverage,
  hasPreRegisterArInPeriod,
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
      '("invoice_created","invoice_paid","invoice_cash_payment","credit_note","reminder_fee","rot_rut_payout","storno","correction")',
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
