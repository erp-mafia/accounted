/**
 * The bulk_book_transactions executor runs the shared dimension policy
 * (enforceBulkBookDimensionPolicy) before the RPC. Staging already ran it,
 * but rules can change and a value can be archived between staging and
 * approval, and the RPC books in SQL without either check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'

function makeBulkBookOp(lines: Array<Record<string, unknown>>): PendingOperation {
  const params: Record<string, unknown> = {
    tx_ids: ['tx-1'],
    existing_journal_entry_id: null,
    new_entry: { description: 'Material', lines },
  }
  return {
    id: 'op-bulk-dims',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    title: 'Samlingsverifikation -400,00 SEK 2026-05-12: Byggvaror',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'agent',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-05-12T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-12T00:00:00Z',
  }
}

const TAGGED = [
  { account_number: '4010', debit_amount: 400, credit_amount: 0, currency: 'SEK', dimensions: { '6': 'P001' } },
  { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
]
const UNTAGGED = [
  { account_number: '4010', debit_amount: 400, credit_amount: 0, currency: 'SEK' },
  { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
]

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    account_number: '4010',
    rule_type: 'default',
    dimensions: { sie_dim_no: 6, name: 'Projekt' },
    dimension_values: { code: 'P001' },
    ...overrides,
  }
}

describe('commitPendingOperation(bulk_book_transactions): dimension policy at approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('refuses a staged tag whose value was archived since staging, before the RPC', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-dims' }, error: null }, // atomic claim pending -> committing
      { data: [], error: null }, // account_dimension_rules
      { data: { dimensions_enabled: true }, error: null },
      { data: [{ id: 'dim-proj', sie_dim_no: 6, name: 'Projekt', is_active: true }], error: null },
      { data: [{ dimension_id: 'dim-proj', code: 'P001', is_active: false }], error: null },
      { data: null, error: null }, // dispatcher: rejected update
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeBulkBookOp(TAGGED))

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('är arkiverat')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses when a required rule added since staging is unsatisfied, before the RPC', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-dims' }, error: null },
      { data: [ruleRow({ rule_type: 'required', dimension_values: null })], error: null },
      { data: null, error: null }, // dispatcher: rejected update
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeBulkBookOp(UNTAGGED))

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('Konto 4010 kräver Projekt')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('posts the tag of a default rule added since staging', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-dims' }, error: null },
      { data: [ruleRow()], error: null }, // account_dimension_rules
      { data: { dimensions_enabled: false }, error: null }, // registry validation: free text
      { data: { ok: true, journal_entry_id: 'je-1', mode: 'create_new', linked_tx_count: 1 }, error: null }, // RPC
      { data: null, error: null }, // finalize committed
    ])

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeBulkBookOp(UNTAGGED))

    expect(result.status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledWith(
      'bulk_book_transactions',
      expect.objectContaining({
        p_new_entry: expect.objectContaining({
          description: 'Material',
          lines: [
            expect.objectContaining({ account_number: '4010', currency: 'SEK', dimensions: { '6': 'P001' } }),
            expect.objectContaining({ account_number: '1930' }),
          ],
        }),
      })
    )
  })
})
