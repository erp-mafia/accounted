import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const matchInboxItemTransaction = vi.fn()
vi.mock('@/lib/documents/inbox-match', () => ({
  matchInboxItemTransaction: (...args: unknown[]) => matchInboxItemTransaction(...args),
}))
const resolveBookedJournalEntryIds = vi.fn()
const completeInboxItemOnEntry = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  resolveBookedJournalEntryIds: (...args: unknown[]) => resolveBookedJournalEntryIds(...args),
  completeInboxItemOnEntry: (...args: unknown[]) => completeInboxItemOnEntry(...args),
}))

import { followInvoiceWithReceipt } from '../inbox-companion'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

const INVOICE_READ = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'X Corp.' },
  invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', dueDate: '2026-10-03', currency: 'SEK' },
  totals: { total: 83 },
}
const RECEIPT_READ = {
  documentKind: 'receipt',
  supplier: { name: 'X Corp.' },
  invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
  totals: { total: 83 },
  payment: { method: 'card', cardLast4: '3667' },
}

function item(id: string, extracted: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'received',
    source: 'email',
    document_id: `doc-${id}`,
    resend_email_id: 'mail-x',
    channel_context: null,
    kind_hint: null,
    extracted_data: extracted,
    routed_to_arkiv_at: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    ...overrides,
  }
}

/** The items by id (read fresh each time), the mail's attachments by resend_email_id. */
function inbox(rows: Map<string, Record<string, unknown>>): TableMockResolver {
  return (calls) => {
    if (calls.some((c) => c.method === 'maybeSingle')) {
      const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
      return { data: rows.get(id) ?? null }
    }
    const mail = calls.find((c) => c.method === 'eq' && c.args[0] === 'resend_email_id')?.args[1]
    return { data: [...rows.values()].filter((r) => r.resend_email_id === mail) }
  }
}

function setup(invoiceOverrides: Record<string, unknown>, payments: unknown[] = [], receiptOverrides: Record<string, unknown> = {}) {
  const rows = new Map<string, Record<string, unknown>>([
    ['invoice', item('invoice', INVOICE_READ, invoiceOverrides)],
    ['receipt', item('receipt', RECEIPT_READ, receiptOverrides)],
  ])
  const mock = createTableMockSupabase({ invoice_inbox_items: inbox(rows), supplier_invoice_payments: { data: payments } })
  const ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: 'user-1', log }
  return { rows, ctx, ...mock }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveBookedJournalEntryIds.mockResolvedValue(new Map())
  completeInboxItemOnEntry.mockResolvedValue('completed')
})

describe('followInvoiceWithReceipt', () => {
  it('Registrera och koppla till betalningen: the receipt joins the payment on its bank row\'s verifikat', async () => {
    const { rows, ctx, findCalls } = setup({ created_supplier_invoice_id: 'si-1' }, [{ transaction_id: 'tx-x' }])
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-pay']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      // The match completes the receipt on the booked row's verifikat.
      rows.set('receipt', { ...rows.get('receipt')!, matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-pay' })
      return { ok: true, data: { id: 'receipt', matched_transaction_id: 'tx-x' } }
    })
    const outcome = await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')
    expect(outcome).toEqual({ ok: true, data: { status: 'completed', journal_entry_id: 'je-pay', transaction_id: 'tx-x' } })
    expect(matchInboxItemTransaction).toHaveBeenCalledWith(ctx, 'receipt', 'tx-x')
    expect(findCalls('supplier_invoice_payments', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY], ['supplier_invoice_id', 'si-1']]))
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
  })

  it('a purchase booked on its matched bank row: the receipt joins the same row', async () => {
    const { rows, ctx } = setup({ matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-1']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      rows.set('receipt', { ...rows.get('receipt')!, matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
      return { ok: true, data: {} }
    })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({
      ok: true,
      data: { status: 'completed', journal_entry_id: 'je-1', transaction_id: 'tx-x' },
    })
  })

  it('an utlägg or the owner\'s own money: the receipt is linked to the invoice\'s own verifikat', async () => {
    const { ctx } = setup({ created_journal_entry_id: 'je-utlagg' })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({
      ok: true,
      data: { status: 'completed', journal_entry_id: 'je-utlagg', transaction_id: null },
    })
    expect(completeInboxItemOnEntry).toHaveBeenCalledWith(
      ctx.supabase,
      COMPANY,
      expect.objectContaining({ id: 'receipt', document_id: 'doc-receipt' }),
      'je-utlagg',
      { basis: 'user_confirmed', evidence: { rule_id: 'inbox_receipt_pair:invoice_number' } },
    )
    expect(matchInboxItemTransaction).not.toHaveBeenCalled()
  })

  it('a link the period lock refuses leaves the receipt in the inbox, and says so', async () => {
    completeInboxItemOnEntry.mockResolvedValue('not_linked')
    const { ctx } = setup({ created_journal_entry_id: 'je-locked' })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'waiting', reason: 'receipt_not_linked' } })
  })

  it.each([
    ['the invoice is not booked yet', {}, [], 'invoice_not_booked'],
    ['the invoice is matched to a row not booked yet', { matched_transaction_id: 'tx-open' }, [], 'invoice_not_booked'],
    ['the invoice is registered and unpaid: the payment it proves is not in the books', { created_supplier_invoice_id: 'si-1' }, [], 'invoice_unpaid'],
    ['the invoice was settled by several rows', { created_supplier_invoice_id: 'si-1' }, [{ transaction_id: 'tx-1' }, { transaction_id: 'tx-2' }], 'several_payments'],
  ])('writes nothing when %s', async (_label, invoiceOverrides, payments, reason) => {
    const { ctx, payloads } = setup(invoiceOverrides, payments)
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'waiting', reason } })
    expect(matchInboxItemTransaction).not.toHaveBeenCalled()
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
    expect(payloads('invoice_inbox_items', 'update')).toEqual([])
  })

  it('says so when the match did not complete the receipt on the verifikat', async () => {
    const { ctx } = setup({ created_supplier_invoice_id: 'si-1' }, [{ transaction_id: 'tx-x' }])
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-pay']]))
    matchInboxItemTransaction.mockResolvedValue({ ok: true, data: {} })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'waiting', reason: 'receipt_not_linked' } })
  })

  it('refuses two items that are not one purchase: another mail, another amount', async () => {
    const other = setup({ created_journal_entry_id: 'je-1' }, [], { resend_email_id: 'another-mail' })
    expect(await followInvoiceWithReceipt(other.ctx, 'invoice', 'receipt')).toEqual({ ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' })
    const amount = setup({ created_journal_entry_id: 'je-1' }, [], { extracted_data: { ...RECEIPT_READ, totals: { total: 166 } } })
    expect(await followInvoiceWithReceipt(amount.ctx, 'invoice', 'receipt')).toEqual({ ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' })
    // Never the other way round: the receipt is not the invoice's invoice.
    const swapped = setup({})
    expect(await followInvoiceWithReceipt(swapped.ctx, 'receipt', 'invoice')).toEqual({ ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' })
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
  })

  it('has nothing to do for a receipt already handled', async () => {
    const { ctx } = setup({ created_journal_entry_id: 'je-1' }, [], { created_journal_entry_id: 'je-1' })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'already_done' } })
  })

  it('answers not found for an item of another company or none', async () => {
    const { ctx, findCalls } = setup({})
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'missing')).toEqual({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('a failed read is an error, never a guess', async () => {
    const mock = createTableMockSupabase({ invoice_inbox_items: { data: null, error: { message: 'boom' } } })
    const outcome = await followInvoiceWithReceipt({ supabase: mock.supabase as never, companyId: COMPANY, userId: 'user-1', log }, 'invoice', 'receipt')
    expect(outcome).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
  })
})
