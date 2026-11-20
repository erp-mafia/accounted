/**
 * Hard blocks on supplier invoices and Inkorg documents (accounted#145):
 * what the doors judge before the database does. The database side is
 * tests/pg/booking-review-supplier-invoices.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { BookingReviewLimitError, BookingReviewRequiredError } from '@/lib/bookkeeping/errors'
import type { PendingOperation } from '@/types'

const run = vi.hoisted(() => ({ error: null as Error | null }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/operations/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operations/registry')>()
  // book_supplier_invoice (the deferred Bokför) whose booking the database refuses for a block.
  const refused = {
    id: 'supplier-invoices.book',
    input: z.object({ supplier_invoice_id: z.string() }),
    run: async () => ({ ok: false, code: 'SI_BOOK_FAILED', error: run.error }),
  }
  return {
    ...actual,
    operationForPendingType: (type: string) =>
      type === 'book_supplier_invoice' ? refused : actual.operationForPendingType(type),
  }
})

import { BOOKING_REVIEW_SOURCES } from '../match'
import { stagedBookingReview } from '@/lib/pending-operations/staged-booking-review'
import { commitPendingOperation } from '@/lib/pending-operations/commit'

const RULE = {
  id: 'r-1',
  rule_id: 'r-1',
  version: 1,
  accounts: null,
  counterparty_key: null,
  counterparty_label: null,
  amount_from_sek: null,
  vat_treatment: null,
  note: null,
  valid_from: '2026-10-29T00:00:00Z',
  created_by: 'u-1',
  created_at: '2026-10-29T00:00:00Z',
  revoked_at: null,
  revoked_by: null,
  revoked_reason: null,
}

/** What gnubok_create_supplier_invoice_from_inbox stages for a 1 250 kr software invoice. */
const STAGED = {
  operation_type: 'create_supplier_invoice_from_inbox',
  params: {
    inbox_item_id: 'item-1',
    supplier_id: 'sup-1',
    supplier_invoice_number: 'F-1',
    invoice_date: '2026-10-20',
    due_date: '2026-11-19',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    items: [{ description: 'Licens', account_number: '6540', line_total: 1000, vat_rate: 0.25, vat_amount: 250 }],
  },
  preview_data: { will_post_journal_entry: true },
}

describe('which journal entries a block judges', () => {
  it('judges bank rows, supplier invoices, Inkorg documents and utlägg, nothing else', () => {
    const judged = Object.entries(BOOKING_REVIEW_SOURCES)
      .filter(([, source]) => source !== null)
      .map(([type]) => type)
      .sort()
    // The list booking_review_entry_matches holds (migration 20261109170100).
    expect(judged).toEqual(['bank_transaction', 'expense_claim', 'inbox_item', 'manual', 'supplier_invoice_cash_payment', 'supplier_invoice_registered'])
    expect(BOOKING_REVIEW_SOURCES.supplier_invoice_paid).toBeNull()
    expect(BOOKING_REVIEW_SOURCES.invoice_created).toBeNull()
  })
})

describe('stagedBookingReview: a staged supplier invoice from the Inkorg', () => {
  let mock: ReturnType<typeof createTableMockSupabase>
  beforeEach(() => {
    mock = createTableMockSupabase({
      booking_review_rules: { data: [{ ...RULE, counterparty_key: 'spotify', counterparty_label: 'Spotify' }] },
      suppliers: { data: { name: 'Spotify AB', supplier_type: 'swedish_business' } },
    })
  })

  it('names the rule its supplier matches, and the invoice total as the amount', async () => {
    const review = await stagedBookingReview(mock.supabase as never, 'c-1', STAGED as never)
    expect(review).toEqual({ matched: [{ id: 'r-1', rule_id: 'r-1', version: 1 }], amountSek: 1250 })
  })

  it('judges the lines its registration books, its VAT and the total in SEK at the staged rate', async () => {
    const judge = async (rule: Partial<typeof RULE>, op: { params: Record<string, unknown> } = STAGED) => {
      mock.setTable('booking_review_rules', { data: [{ ...RULE, ...rule }] })
      return (await stagedBookingReview(mock.supabase as never, 'c-1', op as never))?.matched.length ?? 0
    }
    expect(await judge({ accounts: ['6540'] as never })).toBe(1)
    expect(await judge({ accounts: ['2440'] as never })).toBe(1)
    expect(await judge({ accounts: ['5410'] as never })).toBe(0)
    expect(await judge({ vat_treatment: 'standard_25' as never })).toBe(1)
    expect(await judge({ vat_treatment: 'reverse_charge' as never })).toBe(0)
    const euro = { ...STAGED, params: { ...STAGED.params, currency: 'EUR', exchange_rate: 11.5, total: 100 } }
    expect(await judge({ amount_from_sek: 1150 as never }, euro)).toBe(1)
    expect(await judge({ amount_from_sek: 1151 as never }, euro)).toBe(0)
    mock.setTable('suppliers', { data: { name: 'Spotify AB', supplier_type: 'eu_business' } })
    const reverse = {
      ...STAGED,
      params: {
        ...STAGED.params,
        vat_treatment: 'reverse_charge',
        reverse_charge_kind: 'eu_services',
        vat_amount: 0,
        total: 1000,
        items: [{ description: 'Licens', account_number: '6540', line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25 }],
      },
    }
    expect(await judge({ vat_treatment: 'reverse_charge' as never }, reverse)).toBe(1)
    expect(await judge({ vat_treatment: 'standard_25' as never }, reverse)).toBe(0)
  })

  it('judges the items as the executor stores them: the supplier type default and moms folded into cost', async () => {
    const judge = async (rule: Partial<typeof RULE>, op: { params: Record<string, unknown> }) => {
      mock.setTable('booking_review_rules', { data: [{ ...RULE, ...rule }] })
      return (await stagedBookingReview(mock.supabase as never, 'c-1', op as never))?.matched.length ?? 0
    }
    // No staged treatment from an EU supplier: omvänd betalningsskyldighet, as the executor resolves it.
    mock.setTable('suppliers', { data: { name: 'Spotify AB', supplier_type: 'eu_business' } })
    const unstated = { ...STAGED, params: { ...STAGED.params, vat_treatment: undefined } }
    expect(await judge({ vat_treatment: 'reverse_charge' as never }, unstated)).toBe(1)
    // A company that is not VAT-registered books the seller's moms as cost: no 25 % moms to block.
    mock.setTable('suppliers', { data: { name: 'Spotify AB', supplier_type: 'swedish_business' } })
    mock.setTable('company_settings', { data: { vat_registered: false } })
    expect(await judge({ vat_treatment: 'standard_25' as never }, STAGED)).toBe(0)
    expect(await judge({ vat_treatment: 'none' as never }, STAGED)).toBe(1)
  })

  it('makes a foreign invoice without a rate wait for a person while the company has blocks', async () => {
    const noRate = { ...STAGED, params: { ...STAGED.params, currency: 'EUR', exchange_rate: null } }
    mock.setTable('booking_review_rules', { data: [{ ...RULE, accounts: ['5410'] }] })
    expect(await stagedBookingReview(mock.supabase as never, 'c-1', noRate as never)).toEqual({ matched: [], amountSek: 1250 })
  })

  it('is null when it books nothing now, for another supplier, or without rules', async () => {
    expect(await stagedBookingReview(mock.supabase as never, 'c-1', { ...STAGED, preview_data: { will_post_journal_entry: false } } as never)).toBeNull()
    expect(await stagedBookingReview(mock.supabase as never, 'c-1', { ...STAGED, params: { ...STAGED.params, mode: 'register_booked' } } as never)).toBeNull()
    mock.setTable('suppliers', { data: { name: 'Telia Sverige AB', supplier_type: 'swedish_business' } })
    expect(await stagedBookingReview(mock.supabase as never, 'c-1', STAGED as never)).toBeNull()
    mock.setTable('booking_review_rules', { data: [] })
    expect(await stagedBookingReview(mock.supabase as never, 'c-1', STAGED as never)).toBeNull()
  })
})

describe('commitPendingOperation: an approval the database refuses for a block', () => {
  const op = {
    id: 'op-1',
    user_id: 'u-1',
    company_id: 'c-1',
    operation_type: 'book_supplier_invoice',
    status: 'pending',
    title: 'Bokför leverantörsfaktura',
    params: { supplier_invoice_id: 'si-1' },
    preview_data: {},
    result_data: null,
    actor_type: 'mcp_oauth',
    actor_id: null,
    actor_label: 'Claude',
    risk_level: 'high',
    created_at: '2026-10-31T09:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-31T09:00:00Z',
  } as unknown as PendingOperation

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it.each([
    ['a booking a block holds', () => new BookingReviewRequiredError('je-1'), 'BOOKING_REVIEW_WEB_ONLY'],
    ['a reviewer below the limit', () => new BookingReviewLimitError(1250, 1000), 'BOOKING_REVIEW_LIMIT'],
  ])('goes back to pending for %s, never rejected', async (_case, error, code) => {
    run.error = error()
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // the claim
    enqueue({ data: null, error: null }) // back to pending

    const result = await commitPendingOperation(supabase as never, 'u-1', 'c-1', op, {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })

    expect(result).toMatchObject({ status: 'failed', code, http_status: 403, operation_status: 'pending' })
    const updates = findCalls('pending_operations', 'update').map((args) => args[0])
    expect(updates).toContainEqual({ status: 'pending' })
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'rejected' }))
  })
})
