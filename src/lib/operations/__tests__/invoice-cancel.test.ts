/**
 * invoices.cancel (accounted#20): makulera a quote or proforma through v1 and
 * MCP. The rule lives in cancelQuoteOrProforma, shared with the dashboard
 * route; these tests pin it through the operation, including the staging dry
 * run and a quote that is already partly invoiced (crm#1196).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { cancelQuoteOrProformaTitle, invoicesCancel } from '../invoice-cancel'
import type { OperationContext } from '../types'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const QUOTE = {
  id: QUOTE_ID,
  company_id: COMPANY_ID,
  invoice_number: 'OF-007',
  document_type: 'quote',
  status: 'sent',
  quote_status: 'accepted',
  invoice_date: '2026-10-01',
  subtotal: 10000,
  total: 12500,
  currency: 'SEK',
}

function setup() {
  const mock = createQueuedMockSupabase()
  const ctx: OperationContext = {
    supabase: mock.supabase as never,
    companyId: COMPANY_ID,
    userId: 'user-1',
    log: createLogger('test'),
  }
  return { ...mock, ctx }
}

const run = (ctx: OperationContext, dryRun: boolean) => invoicesCancel.run(ctx, { invoice_id: QUOTE_ID }, { dryRun })

const cancelled = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.on('invoice.cancelled', cancelled)
})

describe('invoices.cancel: contract', () => {
  it('is a low-risk, irreversible invoices:write that stages over MCP as cancel_quote_or_proforma', () => {
    expect(invoicesCancel.kind).toBe('write')
    expect(invoicesCancel.scope).toBe('invoices:write')
    expect(invoicesCancel.risk).toBe('low')
    expect(invoicesCancel.reversible).toBe(false)
    expect(invoicesCancel.http).toMatchObject({
      method: 'POST',
      path: '/api/v1/companies/:companyId/invoices/:id/cancel',
      pathParams: { id: 'invoice_id' },
    })
    expect(invoicesCancel.mcp?.name).toBe('gnubok_cancel_quote_or_proforma')
    expect(invoicesCancel.mcp?.stage?.pendingType).toBe('cancel_quote_or_proforma')
    // Search-only: reachable through gnubok_stage_tool, no tools/list cost.
    expect(invoicesCancel.mcp?.visibility).toBeUndefined()
  })

  it('refuses an id that is not a UUID', () => {
    expect(invoicesCancel.input.safeParse({ invoice_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('titles the approval after the document it cancels', () => {
    expect(cancelQuoteOrProformaTitle({ document_type: 'quote', invoice_number: 'OF-007' })).toBe('Makulera offert OF-007')
    expect(cancelQuoteOrProformaTitle({ document_type: 'proforma', invoice_number: null })).toBe('Makulera proformafaktura')
    expect(cancelQuoteOrProformaTitle(undefined)).toBe('Makulera offert')
  })
})

describe('invoices.cancel: run', () => {
  it('answers INVOICE_NOT_FOUND for a document outside the company', async () => {
    const { ctx, enqueue, findCalls } = setup()
    enqueue({ data: null })

    const outcome = await run(ctx, true)

    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_NOT_FOUND' })
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it.each(['invoice', 'credit_note', 'delivery_note'])('refuses a %s on the dry run and on commit', async (documentType) => {
    for (const dryRun of [true, false]) {
      const { ctx, enqueue, findCall } = setup()
      enqueue({ data: { ...QUOTE, document_type: documentType } })

      const outcome = await run(ctx, dryRun)

      expect(outcome).toMatchObject({
        ok: false,
        code: 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA',
        details: { documentType },
      })
      expect(findCall('invoices', 'update')).toBeUndefined()
    }
  })

  it('previews the cancel on a dry run and writes nothing (the staging preview)', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: QUOTE })

    const outcome = await run(ctx, true)

    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: QUOTE_ID,
        invoice_number: 'OF-007',
        document_type: 'quote',
        current_status: 'sent',
        status: 'cancelled',
        quote_status: 'accepted',
        invoice_date: '2026-10-01',
        total: 12500,
        currency: 'SEK',
      },
    })
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('refuses to stage a document that is already cancelled: nothing is left to do', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ data: { ...QUOTE, status: 'cancelled' } })

    const outcome = await run(ctx, true)

    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_ALREADY_CANCELLED', details: { invoice_id: QUOTE_ID } })
  })

  it('answers an already cancelled document on commit without a write or a second event', async () => {
    const { ctx, enqueue, findCall } = setup()
    enqueue({ data: { ...QUOTE, status: 'cancelled' } })

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({ ok: true, data: { status: 'cancelled', already_cancelled: true } })
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('cancels with a compare-and-set on the status read and records who did it', async () => {
    const { ctx, enqueueMany, findCall, findCalls } = setup()
    enqueueMany([{ data: QUOTE }, { data: { ...QUOTE, status: 'cancelled' } }])

    const outcome = await run(ctx, false)

    expect(outcome).toEqual({
      ok: true,
      data: {
        id: QUOTE_ID,
        invoice_number: 'OF-007',
        document_type: 'quote',
        status: 'cancelled',
        quote_status: 'accepted',
        already_cancelled: false,
      },
    })
    expect(findCall('invoices', 'update')?.[0]).toMatchObject({ status: 'cancelled' })
    expect(findCalls('invoices', 'eq')).toContainEqual(['status', 'sent'])
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled.mock.calls[0][0]).toMatchObject({ userId: 'user-1', companyId: COMPANY_ID })
  })

  // crm#1196: a quote can be invoiced in parts. The existing rule cancels it
  // like any other quote; the invoices converted from it are separate
  // documents and are neither read nor touched.
  it('cancels a partly invoiced quote under the same rule, leaving its invoices alone', async () => {
    const { ctx, enqueueMany, findCalls } = setup()
    enqueueMany([{ data: QUOTE }, { data: { ...QUOTE, status: 'cancelled' } }])

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({ ok: true, data: { status: 'cancelled', already_cancelled: false } })
    expect(findCalls('invoices', 'eq').filter(([column]) => column === 'converted_from_id')).toEqual([])
    expect(findCalls('invoices', 'update')).toHaveLength(1)
    for (const [column, value] of findCalls('invoices', 'eq')) {
      if (column === 'id') expect(value).toBe(QUOTE_ID)
    }
  })

  it('answers INVOICE_CANCEL_RACE when the status changed between the read and the write', async () => {
    const { ctx, enqueueMany } = setup()
    enqueueMany([{ data: QUOTE }, { data: null }])

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_CANCEL_RACE' })
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('hands a database error to the door as INTERNAL_ERROR with the error attached', async () => {
    const { ctx, enqueue } = setup()
    enqueue({ error: { message: 'connection reset', code: '08006' } })

    const outcome = await run(ctx, false)

    expect(outcome).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect((outcome as { error?: unknown }).error).toBeDefined()
  })
})
