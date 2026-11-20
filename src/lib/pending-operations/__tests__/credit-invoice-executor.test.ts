/**
 * The credit_invoice executor (commitCreditInvoice): parse the staged params
 * and call creditInvoice, the credit every door runs, then map its outcome
 * onto the dispatcher's statuses. The credit itself (mirrored items, the
 * period checked first, fail closed) is pinned in
 * lib/invoices/__tests__/credit-invoice.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const { mockCreditInvoice } = vi.hoisted(() => ({ mockCreditInvoice: vi.fn() }))
vi.mock('@/lib/invoices/credit-invoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/credit-invoice')>()),
  creditInvoice: mockCreditInvoice,
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'credit_invoice',
    status: 'pending',
    title: 'Kreditera faktura F-2026001',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-10-13T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-13T00:00:00Z',
  } as PendingOperation
}

async function commit(params: Record<string, unknown>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
  enqueue({ data: null, error: null }) // dispatcher pending_operations update
  return commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp(params))
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: credit_invoice through creditInvoice', () => {
  it('commits an operation staged in the old params shape ({ invoice_id, reason })', async () => {
    mockCreditInvoice.mockResolvedValue({
      ok: true,
      creditNoteId: 'cn-1',
      journalEntryId: 'je-1',
      partialFailures: [],
    })

    const result = await commit({ invoice_id: 'inv-1', reason: 'Fel belopp' })

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ credit_note_id: 'cn-1', journal_entry_id: 'je-1' })
    // The door says what the one-call credit did not do: nothing reached the customer.
    expect((result.data as { warning?: string }).warning).toContain('inte skickats till kunden')
    expect(mockCreditInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'inv-1',
      { reason: 'Fel belopp' },
    )
  })

  it('a refused verifikat rejects the operation: nothing posted, the original untouched', async () => {
    mockCreditInvoice.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
      details: { failure_steps: ['journal_entry'] },
      failures: [{ step: 'journal_entry', reason: 'Konto 3001 kräver Projekt' }],
    })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('rejected')
    expect(result.code).not.toBe('partial_commit')
    expect(result.error).toContain('Konto 3001 kräver Projekt')
  })

  it('a verifikat that posted before a later step failed lands in failed_partial with its ids', async () => {
    const postedIds = { credit_note_id: 'cn-1', original_invoice_id: 'inv-1', journal_entry_id: 'je-1' }
    mockCreditInvoice.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREDIT_REPAIR_REQUIRED',
      details: { failure_steps: ['journal_link'] },
      failures: [{ step: 'journal_link', reason: 'Kreditfakturan kunde inte kopplas till verifikatet.' }],
      postedIds,
    })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.status).toBe('failed')
    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({ posted_ids: postedIds })
    expect(result.operation_status).toBe('failed_partial')
  })

  it('auto-rejects (409) an original credited since staging', async () => {
    mockCreditInvoice.mockResolvedValue({ ok: false, code: 'INVOICE_CREDIT_ALREADY_CREDITED' })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it.each([
    ['INVOICE_CREDIT_PERIOD_LOCKED', 400],
    ['INVOICE_CREDIT_NOT_INVOICE', 400],
    ['INVOICE_CREDIT_NOT_SENT', 400],
    // accounted#45: the deferred original could not be booked first.
    ['INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED', 400],
    ['INVOICE_CREDIT_ORIGINAL_BOOK_FAILED', 400],
  ])('rejects %s with its registry status', async (code, status) => {
    mockCreditInvoice.mockResolvedValue({ ok: false, code, details: { reason: 'x' } })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(status)
    expect(result.code).toBe(code)
  })

  // accounted#45: a deferred original that was never booked is booked first.
  it('answers the original\'s new verifikat beside the credit\'s', async () => {
    mockCreditInvoice.mockResolvedValue({
      ok: true,
      creditNoteId: 'cn-1',
      journalEntryId: 'je-credit',
      originalJournalEntryId: 'je-original',
      partialFailures: [],
    })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      credit_note_id: 'cn-1',
      journal_entry_id: 'je-credit',
      original_journal_entry_id: 'je-original',
    })
  })

  it('lands in failed_partial when the original was booked but the credit then failed', async () => {
    const postedIds = { credit_note_id: 'cn-1', original_invoice_id: 'inv-1', original_journal_entry_id: 'je-original' }
    mockCreditInvoice.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
      details: { failure_steps: ['journal_entry'] },
      failures: [{ step: 'journal_entry', reason: 'Perioden är låst Originalfakturan har bokförts. Försök kreditera igen.' }],
      postedIds,
    })

    const result = await commit({ invoice_id: 'inv-1' })

    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({ posted_ids: postedIds })
    expect(result.operation_status).toBe('failed_partial')
  })
})
