import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  fetchInvoiceRegisterCoverage,
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
    expect(findCall('journal_entry_lines', 'select')).toBeUndefined()
  })

  it('flags pre-register invoices when a posted AR verifikat predates the first invoice', async () => {
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: { id: 'line-1' }, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual({
      covers_from: '2026-07-19',
      has_pre_register_invoices: true,
    })
    // The probe is AR-scoped (1510/1513), company-scoped via the join, and
    // excludes the invoice engine's own entries.
    expect(findCall('journal_entry_lines', 'in')).toEqual([
      'account_number',
      ['1510', '1513'],
    ])
    const eqCalls = findCalls('journal_entry_lines', 'eq')
    expect(eqCalls).toContainEqual(['journal_entry.company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['journal_entry.status', 'posted'])
    expect(findCall('journal_entry_lines', 'lt')).toEqual([
      'journal_entry.entry_date',
      '2026-07-19',
    ])
    expect(findCall('journal_entry_lines', 'not')).toEqual([
      'journal_entry.source_type',
      'in',
      '("invoice_created","invoice_paid")',
    ])
  })

  it('reports full coverage when no AR verifikat predates the first invoice', async () => {
    enqueue({ data: { invoice_date: '2026-01-02' }, error: null })
    enqueue({ data: null, error: null })

    const coverage = await fetchInvoiceRegisterCoverage(client, 'company-1')

    expect(coverage).toEqual({
      covers_from: '2026-01-02',
      has_pre_register_invoices: false,
    })
  })
})
