import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { commitPendingOperation } from '../commit'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-invoice-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'update_invoice',
    status: 'pending',
    title: 'Update invoice draft',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Test key',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-07-27T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-27T00:00:00Z',
  } as PendingOperation
}

function existingDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'draft',
    invoice_number: null,
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    customer_id: CUSTOMER_ID,
    document_type: 'invoice',
    invoice_date: '2026-07-01',
    due_date: '2026-07-31',
    delivery_date: null,
    currency: 'SEK',
    your_reference: null,
    our_reference: null,
    notes: null,
    payment_link_url: null,
    payment_link_auto: true,
    ore_rounding: null,
    default_dimensions: {},
    deduction_personnummer_encrypted: null,
    deduction_personnummer_last4: null,
    ...overrides,
  }
}

const NEW_ITEMS = [
  { description: 'Konsultation', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 },
]

const ARTICLE_ID = '44444444-4444-4444-8444-444444444444'
const ARTICLE_ITEMS = [
  {
    description: 'Konsulttimme',
    quantity: 3,
    unit: 'tim',
    unit_price: 1200,
    vat_rate: 25,
    article_id: ARTICLE_ID,
    revenue_account: '3041',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: update_invoice', () => {
  it('replaces the items, recomputes VAT/totals, and returns qualified ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim pending -> committing
    enqueue({ data: existingDraft() }) // invoices: existing draft
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID }) }) // customers
    enqueue({ data: { vat_registered: true } }) // company_settings (builder VAT gate)
    enqueue({ data: [{ id: INVOICE_ID }] }) // invoices update (draft-guarded)
    enqueue({ data: null }) // invoice_items delete
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: null }) // pending_operations final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { items: NEW_ITEMS } }),
    )

    expect(result.status).toBe('committed')
    // Money math: 2 x 1000 = 2000 net, 25% VAT = 500, total 2500.
    expect(result.data).toMatchObject({
      invoice_id: INVOICE_ID,
      subtotal: 2000,
      vat_amount: 500,
      total: 2500,
      item_count: 1,
      items_replaced: true,
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'invoices')
    expect(supabase.from).toHaveBeenNthCalledWith(6, 'invoice_items')
    expect(supabase.from).toHaveBeenNthCalledWith(7, 'invoice_items')
  })

  it('keeps the existing lines on a header-only edit (no full replace staged)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim
    enqueue({ data: existingDraft() }) // invoices: existing draft
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID }) }) // customers
    enqueue({
      // invoice_items: current rows fed back through the builder
      data: [
        {
          line_type: 'product',
          description: 'Befintlig rad',
          quantity: 1,
          unit: 'st',
          unit_price: 100,
          vat_rate: 25,
          article_id: null,
          revenue_account: null,
          deduction_type: null,
          labor_hours: null,
          work_type: null,
          housing_designation: null,
          apartment_number: null,
          brf_org_number: null,
          accrual_period_start: null,
          accrual_period_end: null,
          accrual_balance_account: null,
          dimensions: {},
        },
      ],
    })
    enqueue({ data: { vat_registered: true } }) // company_settings
    enqueue({ data: [{ id: INVOICE_ID }] }) // invoices update
    enqueue({ data: null }) // invoice_items delete
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: null }) // final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { notes: 'Uppdaterad anteckning' } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_id: INVOICE_ID,
      subtotal: 100,
      vat_amount: 25,
      total: 125,
      item_count: 1,
      items_replaced: false,
    })
  })

  it('re-checks the editable-draft gate at commit time (sent between staging and approval)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim
    enqueue({ data: existingDraft({ status: 'sent', invoice_number: '2026-0042' }) })
    enqueue({ data: null }) // final status update (auto-reject)

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { notes: 'x' } }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    // Only claim + invoice fetch + status update: the write never ran.
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('re-checks the gate for a draft that gained a verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } })
    enqueue({ data: existingDraft({ journal_entry_id: 'je-1' }) })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { notes: 'x' } }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
  })

  it('auto-rejects when the invoice no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } })
    enqueue({ data: null }) // invoices: gone
    enqueue({ data: null }) // final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { notes: 'x' } }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
  })

  it('enforces the VAT rate gate on replaced items', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim
    enqueue({ data: existingDraft() }) // invoices
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID }) }) // customers
    enqueue({ data: { vat_registered: true } }) // company_settings
    enqueue({ data: null }) // final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        invoice_id: INVOICE_ID,
        // 19% is not a Swedish VAT rate: the builder must refuse it.
        changes: { items: [{ description: 'Rad', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 19 }] },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('keeps article_id and revenue_account on replaced items (issue #1642)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim pending -> committing
    enqueue({ data: existingDraft() }) // invoices: existing draft
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID }) }) // customers
    enqueue({ data: [{ id: ARTICLE_ID }] }) // articles: company-scope gate
    enqueue({ data: { vat_registered: true } }) // company_settings (builder VAT gate)
    enqueue({ data: [{ account_number: '3041' }] }) // chart_of_accounts: override account
    enqueue({ data: [{ id: INVOICE_ID }] }) // invoices update (draft-guarded)
    enqueue({ data: [] }) // invoice_items snapshot (replaceInvoiceItems)
    enqueue({ data: null }) // invoice_items delete
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: null }) // pending_operations final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { items: ARTICLE_ITEMS } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ subtotal: 3600, vat_amount: 900, total: 4500, items_replaced: true })
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'articles')
    // The rewritten line keeps its article linkage and the 3041 override:
    // the quantity fix must not rebook revenue to the VAT-derived default.
    const inserted = findCall('invoice_items', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      invoice_id: INVOICE_ID,
      article_id: ARTICLE_ID,
      revenue_account: '3041',
      quantity: 3,
      vat_rate: 25,
    })
  })

  it('rejects a staged article outside the company before writing anything', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } }) // claim
    enqueue({ data: existingDraft() }) // invoices
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID }) }) // customers
    enqueue({ data: [] }) // articles: no company-scoped hit
    enqueue({ data: null }) // final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ invoice_id: INVOICE_ID, changes: { items: ARTICLE_ITEMS } }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/finns inte i företaget/)
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(findCall('invoice_items', 'insert')).toBeUndefined()
  })

  it('rejects tampered staged params before reading the invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-invoice-1' } })
    enqueue({ data: null }) // final status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        invoice_id: INVOICE_ID,
        changes: { status: 'paid', notes: 'x' },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key|invalid/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})
