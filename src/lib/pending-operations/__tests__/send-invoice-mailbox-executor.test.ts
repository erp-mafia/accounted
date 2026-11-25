/**
 * send_invoice staged with channel kivra or billo (gnubok_send_invoice):
 * approval runs the invoice page's send to the customer's digital mailbox
 * (lib/invoices/digital-mailbox-send.ts), with its usage gate and dispatch
 * log, and never the email path. A delivery that fails after a draft was
 * booked on issue lands failed_partial with the verifikat, as the email send
 * does; a refusal before anything happened is a plain rejection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

const mocks = vi.hoisted(() => ({
  sendInvoiceToDigitalMailbox: vi.fn(),
  getEmailService: vi.fn(),
  service: { service: true },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => mocks.service,
}))
vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/invoices/digital-mailbox-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/digital-mailbox-send')>()),
  sendInvoiceToDigitalMailbox: mocks.sendInvoiceToDigitalMailbox,
}))
vi.mock('@/lib/email/service', () => ({ getEmailService: mocks.getEmailService }))

import { commitPendingOperation } from '../commit'

function sendOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'send_invoice',
    status: 'pending',
    title: 'Skicka till Kivra: F-1042',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-11-24T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-11-24T00:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: send_invoice to a digital mailbox', () => {
  it('runs the mailbox send for the staged provider and returns its dispatch', async () => {
    mocks.sendInvoiceToDigitalMailbox.mockResolvedValue({
      ok: true,
      data: { dispatch_id: 'd-1', provider: 'kivra', provider_ref: 'content-1', recipient_kind: 'company', issued: true, journal_entry_id: 'je-1' },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp({ invoice_id: 'inv-1', channel: 'kivra' }))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ invoice_id: 'inv-1', channel: 'kivra', dispatch_id: 'd-1', issued: true, journal_entry_id: 'je-1' })
    expect(mocks.sendInvoiceToDigitalMailbox).toHaveBeenCalledWith(
      expect.objectContaining({ supabase, service: mocks.service, companyId: 'company-1', userId: 'user-1' }),
      'inv-1',
      'kivra',
    )
    // Never the email path.
    expect(mocks.getEmailService).not.toHaveBeenCalled()
  })

  it('rejects with the send\'s own code when it refuses before anything happened', async () => {
    mocks.sendInvoiceToDigitalMailbox.mockResolvedValue({
      ok: false,
      code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE',
      details: { recipient_kind: 'person' },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp({ invoice_id: 'inv-1', channel: 'billo' }))

    expect(result.code).toBe('DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE')
    expect(result.operation_status).toBe('rejected')
    expect(result.error).toMatch(/ingen brevlåda/)
    expect(mocks.sendInvoiceToDigitalMailbox.mock.calls[0]![2]).toBe('billo')
  })

  it('lands failed_partial with the verifikat when the delivery fails after the issue', async () => {
    mocks.sendInvoiceToDigitalMailbox.mockResolvedValue({
      ok: false,
      code: 'DIGITAL_MAILBOX_SEND_FAILED',
      details: { issued: true, journal_entry_id: 'je-7' },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp({ invoice_id: 'inv-1', channel: 'kivra' }))

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('failed_partial')
    expect(result.data).toEqual({ posted_ids: { journal_entry_id: 'je-7' } })
    expect(result.error).toMatch(/Fakturan är utfärdad/)
  })

  it('refuses a tampered channel without sending anything', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp({ invoice_id: 'inv-1', channel: 'fax' }))

    expect(result.code).toBe('VALIDATION_ERROR')
    expect(mocks.sendInvoiceToDigitalMailbox).not.toHaveBeenCalled()
    expect(mocks.getEmailService).not.toHaveBeenCalled()
  })
})
