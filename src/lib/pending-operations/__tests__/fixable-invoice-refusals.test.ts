/**
 * The invoice refusals a person fixes around the proposal (tracker #206
 * point 2, lib/pending-operations/fixable-refusals.ts): the app's single
 * approval keeps the proposal pending with the code; every other door, and
 * every refusal not on the list, still closes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice, makeCustomer } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

const mocks = vi.hoisted(() => ({
  issueAndBookInvoice: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, journalEntryId: 'je-1', partialFailures: [] })),
}))

vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))
// send_invoice is a paid operation: the company has the capability here.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => true, sendEmail: vi.fn() }),
}))
vi.mock('@/lib/invoices/issue-and-book-invoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/issue-and-book-invoice')>()),
  issueAndBookInvoice: mocks.issueAndBookInvoice,
}))

import { commitPendingOperation } from '../commit'

const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@example.se' })

function draftInvoice() {
  return makeInvoice({
    id: 'invoice-1',
    status: 'draft',
    invoice_number: null as unknown as string,
    credited_invoice_id: null,
    document_type: 'invoice',
    currency: 'SEK',
    customer,
    items: [],
  })
}

const SETTINGS = { company_name: 'Test AB', accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' }

function op(operation_type: PendingOperation['operation_type']): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type,
    params: { invoice_id: 'invoice-1' },
    status: 'pending',
    title: 'test',
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
  } as unknown as PendingOperation
}

const APP = { commitMethod: 'user_accept', keepFixableRefusals: true } as const

function statuses(findCalls: (table: string, method: string) => unknown[][]): Array<string | undefined> {
  return findCalls('pending_operations', 'update').map((args) => (args[0] as { status?: string }).status)
}

async function markSent(refusal: Record<string, unknown>, opts: Parameters<typeof commitPendingOperation>[4]) {
  mocks.issueAndBookInvoice.mockResolvedValueOnce({ ok: false, ...refusal })
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
  enqueue({ data: draftInvoice(), error: null })
  enqueue({ data: SETTINGS, error: null })
  enqueue({ data: null, error: null }) // back to pending, or rejected
  const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('mark_invoice_sent'), opts)
  return { result, statuses: statuses(findCalls) }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: mark_invoice_sent refused for something the person fixes', () => {
  it('INVOICE_NUMBER_SERIES_BEHIND keeps the proposal pending with the code, the sentence and the numbers', async () => {
    const { result, statuses: written } = await markSent(
      {
        errorCode: 'INVOICE_NUMBER_SERIES_BEHIND',
        messageSv: 'Nummerserien har redan nummer 120. Ställ in Nästa fakturanummer på 121 eller högre.',
        details: { prefix: '', highest_number: 120, first_allowed: 121 },
      },
      APP,
    )
    expect(result).toMatchObject({
      status: 'failed',
      http_status: 409,
      code: 'INVOICE_NUMBER_SERIES_BEHIND',
      error: 'Nummerserien har redan nummer 120. Ställ in Nästa fakturanummer på 121 eller högre.',
      operation_status: 'pending',
    })
    expect(written).toEqual(['committing', 'pending'])
  })

  it('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING keeps the proposal pending with the code', async () => {
    const { result, statuses: written } = await markSent({ errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING' }, APP)
    expect(result).toMatchObject({ status: 'failed', http_status: 400, code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', operation_status: 'pending' })
    expect(written).toEqual(['committing', 'pending'])
  })

  it('INVOICE_SEND_VAT_NUMBER_MISSING keeps the proposal pending with the code', async () => {
    const { result, statuses: written } = await markSent({ errorCode: 'INVOICE_SEND_VAT_NUMBER_MISSING' }, APP)
    expect(result).toMatchObject({ status: 'failed', http_status: 400, code: 'INVOICE_SEND_VAT_NUMBER_MISSING', operation_status: 'pending' })
    expect(written).toEqual(['committing', 'pending'])
  })

  it('the same refusals still close the proposal for every other door', async () => {
    for (const errorCode of ['INVOICE_NUMBER_SERIES_BEHIND', 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', 'INVOICE_SEND_VAT_NUMBER_MISSING']) {
      const { result, statuses: written } = await markSent({ errorCode }, { commitMethod: 'bulk_accept' })
      expect(result.operation_status, errorCode).toBe('rejected')
      expect(result.code, errorCode).toBe(errorCode)
      expect(written, errorCode).toEqual(['committing', 'rejected'])
    }
  })

  it('a refusal not on the list still closes the proposal under the app approval', async () => {
    const { result, statuses: written } = await markSent({ errorCode: 'INVOICE_MARK_SENT_RACE' }, APP)
    expect(result).toMatchObject({ status: 'rejected', http_status: 409, operation_status: 'rejected' })
    expect(written).toEqual(['committing', 'rejected'])
  })
})

describe('commitPendingOperation: send_invoice refused for missing payment details', () => {
  async function send(opts: Parameters<typeof commitPendingOperation>[4]) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: { ...SETTINGS, bankgiro: null }, error: null }) // no payment details at all
    enqueue({ data: null, error: null }) // back to pending, or rejected
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('send_invoice'), opts)
    return { result, statuses: statuses(findCalls) }
  }

  it('keeps the proposal pending under the app approval, before a number, a delivery or an email', async () => {
    const { result, statuses: written } = await send(APP)
    expect(result).toMatchObject({ status: 'failed', http_status: 400, code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', operation_status: 'pending' })
    expect(written).toEqual(['committing', 'pending'])
    expect(mocks.issueAndBookInvoice).not.toHaveBeenCalled()
  })

  it('closes it for every other door, now with the code', async () => {
    const { result, statuses: written } = await send({ commitMethod: 'api_key' })
    expect(result).toMatchObject({ status: 'failed', http_status: 400, code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', operation_status: 'rejected' })
    expect(written).toEqual(['committing', 'rejected'])
  })
})
