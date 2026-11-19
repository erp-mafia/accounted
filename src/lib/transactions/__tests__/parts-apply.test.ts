/**
 * applyTransactionSplit as both doors see it (the Open Payments ingest and the
 * BG Max file): what it stores, which invoice each part is offered, when it
 * marks the row, and what the payment match log records. Pinned before the
 * open-invoice suggestions moved behind the bank side's plug-in point
 * (lib/composition/open-invoices.ts), so the move keeps every write.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase, makeCustomer, makeInvoice, makeSupplier, makeSupplierInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankTransactionPartInput } from '@/types'
import { applyTransactionSplit } from '../parts-apply'

function part(overrides: Partial<BankTransactionPartInput> = {}): BankTransactionPartInput {
  return {
    amount: 500,
    currency: 'SEK',
    counterparty_name: null,
    counterparty_org_number: null,
    counterparty_account: null,
    reference: null,
    invoice_numbers: [],
    message: null,
    provider_part_id: null,
    ...overrides,
  }
}

const kundAb = makeCustomer({ id: 'cust-kund', name: 'Kund AB', org_number: '5560160680' })
// OCR 1001 -> 10017, 1002 -> 10025 (lib/invoices/ocr-keys.ts).
const invoice1001 = { ...makeInvoice({ id: 'inv-1001', invoice_number: '1001', status: 'sent', total: 500, remaining_amount: 500, customer_id: kundAb.id }), customer: kundAb }
const invoice1002 = { ...makeInvoice({ id: 'inv-1002', invoice_number: '1002', status: 'sent', total: 1000, remaining_amount: 1000, customer_id: kundAb.id }), customer: kundAb }

const tele = makeSupplier({ id: 'sup-tele', name: 'Tele AB', bankgiro: '5555-5555', org_number: null })
const teleInvoice = makeSupplierInvoice({ id: 'si-tele', supplier_id: tele.id, supplier_invoice_number: 'INV-77', payment_reference: '4711000000009', total: 1200, remaining_amount: 1200, supplier: tele })

const ok = { data: null, error: null }

describe('applyTransactionSplit', () => {
  it('a deposit whose parts all resolve: stores them with their invoices, marks the row and logs the allocations', async () => {
    const { supabase, enqueueMany, calls, findCalls } = createQueuedMockSupabase()
    enqueueMany([ok, ok, ok, ok])
    const result = await applyTransactionSplit(supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      tx: { id: 'tx-1', amount: 1500, potential_journal_entry_id: null, potential_match_method: null },
      parts: [part({ amount: 500, reference: '10017' }), part({ amount: 1000, invoice_numbers: ['1002'] })],
      pools: { customerInvoices: [invoice1001, invoice1002], supplierInvoices: [teleInvoice], excludeInvoiceIds: new Set() },
    })

    expect(result).toEqual({
      complete: true,
      suggestions: [
        { seq: 1, suggested_invoice_id: 'inv-1001', suggested_supplier_invoice_id: null, suggestion_reason: 'ocr_exact' },
        { seq: 2, suggested_invoice_id: 'inv-1002', suggested_supplier_invoice_id: null, suggestion_reason: 'invoice_number' },
      ],
    })
    expect(calls.filter((c) => c.method === 'delete' || c.method === 'insert' || c.method === 'update').map((c) => `${c.table}.${c.method}`)).toEqual([
      'bank_transaction_parts.delete',
      'bank_transaction_parts.insert',
      'transactions.update',
      'payment_match_log.insert',
    ])
    const stored = findCalls('bank_transaction_parts', 'insert')[0]![0] as Array<Record<string, unknown>>
    expect(stored.map((r) => [r.seq, r.suggested_invoice_id, r.suggestion_reason])).toEqual([
      [1, 'inv-1001', 'ocr_exact'],
      [2, 'inv-1002', 'invoice_number'],
    ])
    expect(findCalls('transactions', 'update')[0]![0]).toEqual({
      potential_match_method: 'bankgiro_split',
      potential_match_confidence: 0.95,
      potential_invoice_id: null,
      potential_supplier_invoice_id: null,
    })
    expect(findCalls('payment_match_log', 'insert')[0]![0]).toEqual({
      user_id: 'user-1',
      transaction_id: 'tx-1',
      invoice_id: null,
      supplier_invoice_id: null,
      action: 'auto_suggested',
      match_confidence: 0.95,
      match_method: 'bankgiro_split',
      previous_state: null,
      new_state: {
        allocations: [
          { seq: 1, amount: 500, invoice_id: 'inv-1001' },
          { seq: 2, amount: 1000, invoice_id: 'inv-1002' },
        ],
      },
    })
  })

  it('a payout whose split no longer explains the row: suggests from the supplier pool and takes the old marker off', async () => {
    const { supabase, enqueueMany, calls, findCalls } = createQueuedMockSupabase()
    enqueueMany([ok, ok, ok])
    const result = await applyTransactionSplit(supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      tx: { id: 'tx-2', amount: -1500, potential_journal_entry_id: null, potential_match_method: 'bankgiro_split' },
      parts: [part({ amount: -1200, reference: '4711000000009' }), part({ amount: -300 })],
      pools: { customerInvoices: [invoice1001], supplierInvoices: [teleInvoice] },
    })

    expect(result).toEqual({
      complete: false,
      suggestions: [
        { seq: 1, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-tele', suggestion_reason: 'ocr_exact' },
        { seq: 2, suggested_invoice_id: null, suggested_supplier_invoice_id: null, suggestion_reason: null },
      ],
    })
    expect(findCalls('transactions', 'update')).toEqual([[{ potential_match_method: null, potential_match_confidence: null }]])
    expect(calls.some((c) => c.table === 'payment_match_log')).toBe(false)
  })

  it('a decided row: stores the parts without suggestions and touches nothing else', async () => {
    const { supabase, enqueueMany, calls, findCalls } = createQueuedMockSupabase()
    enqueueMany([ok, ok])
    const result = await applyTransactionSplit(supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      tx: { id: 'tx-3', amount: 1500 },
      parts: [part({ amount: 500, reference: '10017' }), part({ amount: 1000 })],
      pools: null,
    })

    expect(result).toEqual({ suggestions: null, complete: false })
    expect(calls.map((c) => c.table).filter((t, i, all) => all.indexOf(t) === i)).toEqual(['bank_transaction_parts'])
    const stored = findCalls('bank_transaction_parts', 'insert')[0]![0] as Array<Record<string, unknown>>
    expect(stored.map((r) => r.suggested_invoice_id)).toEqual([null, null])
  })

  it('a row with a voucher suggestion keeps its method: a complete split only clears the single-invoice hints', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([ok, ok, ok, ok])
    const result = await applyTransactionSplit(supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      tx: { id: 'tx-4', amount: 1500, potential_journal_entry_id: 'je-1', potential_match_method: 'auto_exact' },
      parts: [part({ amount: 500, reference: '10017' }), part({ amount: 1000, reference: '10025' })],
      pools: { customerInvoices: [invoice1001, invoice1002], supplierInvoices: [] },
    })

    expect(result.complete).toBe(true)
    expect(findCalls('transactions', 'update')).toEqual([[{ potential_invoice_id: null, potential_supplier_invoice_id: null }]])
  })

  it('throws when the marking write is refused', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([ok, ok, { error: { message: 'refused' } }])
    await expect(
      applyTransactionSplit(supabase as unknown as SupabaseClient, {
        companyId: 'company-1',
        userId: 'user-1',
        tx: { id: 'tx-5', amount: 1500 },
        parts: [part({ amount: 500, reference: '10017' }), part({ amount: 1000, reference: '10025' })],
        pools: { customerInvoices: [invoice1001, invoice1002], supplierInvoices: [] },
      }),
    ).rejects.toEqual({ message: 'refused' })
  })
})
