import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { commitPendingOperation } from '../commit'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-delete-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'delete_draft_invoice',
    status: 'pending',
    title: 'Ta bort fakturautkast',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Test key',
    risk_level: 'high',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-08-30T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-30T00:00:00Z',
  } as PendingOperation
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'draft',
    invoice_number: null,
    user_id: 'user-1',
    credited_invoice_id: null,
    journal_entry_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: delete_draft_invoice', () => {
  it('hard deletes an unnumbered draft and emits the audit event with the explicit actor', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim pending -> committing
    enqueue({ data: invoiceRow() }) // invoices: fetch (draft, unnumbered)
    enqueue({ data: [{ id: INVOICE_ID }] }) // invoices: delete().select('id')
    enqueue({ data: null }) // pending_operations final status update

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ invoice_id: INVOICE_ID, deleted: true })
    // The hard delete leaves no journal trace: the audit event carries the
    // EXPLICIT actor (the MCP path runs on a service client, auth.uid() null).
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'invoice.draft_deleted',
      payload: { invoiceId: INVOICE_ID, companyId: 'company-1', userId: 'user-1' },
    })
  })

  it('cancels a numbered draft (makulering), retaining the F-series number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim
    enqueue({ data: invoiceRow({ invoice_number: 'F-2026042' }) }) // fetch
    enqueue({ data: [{ id: INVOICE_ID }] }) // invoices: update().select('id')
    enqueue({ data: null }) // pending_operations final status update

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_id: INVOICE_ID,
      cancelled: true,
      invoice_number: 'F-2026042',
    })
    // Makulering leaves its trail in the invoice row: no delete event.
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('auto-rejects (409) when the invoice left draft between staging and approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: 'F-2026042' }) }) // fetch
    enqueue({ data: null }) // pending_operations rejected status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('INVOICE_DELETE_NOT_DRAFT')
    expect(result.error).toMatch(/status: sent/)
  })

  it('auto-rejects (409) on the TOCTOU race: draft finalized during the delete', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim
    enqueue({ data: invoiceRow() }) // fetch: unnumbered draft
    enqueue({ data: [] }) // delete matched 0 rows (finalized concurrently)
    enqueue({ data: null }) // pending_operations rejected status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('auto-rejects (404) when the invoice no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim
    enqueue({ data: null, error: { message: 'not found' } }) // fetch fails
    enqueue({ data: null }) // pending_operations rejected status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(result.code).toBe('INVOICE_NOT_FOUND')
  })

  it('fails (400) when the staged params carry no invoice_id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-delete-1' } }) // claim
    enqueue({ data: null }) // pending_operations failed status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({}),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})
