import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const matchInboxItemTransaction = vi.fn()
vi.mock('@/lib/documents/inbox-match', () => ({
  matchInboxItemTransaction: (...args: unknown[]) => matchInboxItemTransaction(...args),
}))
const resolveBookedJournalEntryIds = vi.fn()
const completeInboxItemOnEntry = vi.fn()
const lockedJournalEntryIds = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  resolveBookedJournalEntryIds: (...args: unknown[]) => resolveBookedJournalEntryIds(...args),
  completeInboxItemOnEntry: (...args: unknown[]) => completeInboxItemOnEntry(...args),
  lockedJournalEntryIds: (...args: unknown[]) => lockedJournalEntryIds(...args),
}))

import { followInvoiceWithReceipt, followPairedReceipt, followReceiptsOfSupplierInvoice } from '../inbox-companion'

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
    const registeredAs = calls.find((c) => c.method === 'eq' && c.args[0] === 'created_supplier_invoice_id')?.args[1]
    if (registeredAs) return { data: [...rows.values()].filter((r) => r.created_supplier_invoice_id === registeredAs) }
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
  lockedJournalEntryIds.mockResolvedValue(new Set())
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

describe('followPairedReceipt: the server brings the receipt along when a door books the invoice', () => {
  it('book-direct on the invoice\'s own verifikat: the receipt is completed on it, found from the invoice alone', async () => {
    const { ctx } = setup({ created_journal_entry_id: 'je-1' })
    expect(await followPairedReceipt(ctx, 'invoice')).toEqual({ status: 'completed', journal_entry_id: 'je-1', transaction_id: null })
    expect(completeInboxItemOnEntry).toHaveBeenCalledWith(
      ctx.supabase,
      COMPANY,
      expect.objectContaining({ id: 'receipt' }),
      'je-1',
      { basis: 'user_confirmed', evidence: { rule_id: 'inbox_receipt_pair:invoice_number' } },
    )
  })

  it('book-direct with the bank row: the receipt joins the same row', async () => {
    const { rows, ctx } = setup({ matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-1']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      rows.set('receipt', { ...rows.get('receipt')!, matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
      return { ok: true, data: {} }
    })
    expect(await followPairedReceipt(ctx, 'invoice')).toEqual({ status: 'completed', journal_entry_id: 'je-1', transaction_id: 'tx-x' })
    expect(matchInboxItemTransaction).toHaveBeenCalledWith(ctx, 'receipt', 'tx-x')
  })

  it('does nothing for an invoice that came alone, for the receipt itself, or for a receipt already handled', async () => {
    const alone = setup({ created_journal_entry_id: 'je-1' }, [], { resend_email_id: 'another-mail' })
    expect(await followPairedReceipt(alone.ctx, 'invoice')).toEqual({ status: 'no_receipt' })
    const receiptSide = setup({ created_journal_entry_id: 'je-1' })
    expect(await followPairedReceipt(receiptSide.ctx, 'receipt')).toEqual({ status: 'no_receipt' })
    // A second run (the page's own call, a retry) finds the receipt booked: idempotent.
    const done = setup({ created_journal_entry_id: 'je-1' }, [], { created_journal_entry_id: 'je-1' })
    expect(await followPairedReceipt(done.ctx, 'invoice')).toEqual({ status: 'no_receipt' })
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
    expect(matchInboxItemTransaction).not.toHaveBeenCalled()
  })

  it('never throws: a failed read is answered as failed and logged', async () => {
    const mock = createTableMockSupabase({ invoice_inbox_items: { data: null, error: { message: 'boom' } } })
    const ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: 'user-1', log }
    expect(await followPairedReceipt(ctx, 'invoice')).toEqual({ status: 'failed', code: 'UNKNOWN_ERROR' })
  })
})

describe('followReceiptsOfSupplierInvoice: a registered invoice paid later takes its receipt to the payment', () => {
  it('the supplier invoice is settled by one bank row: the receipt joins the payment\'s verifikat', async () => {
    const { rows, ctx, findCalls } = setup({ created_supplier_invoice_id: 'si-1' }, [{ transaction_id: 'tx-pay' }])
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-pay', 'je-pay']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      rows.set('receipt', { ...rows.get('receipt')!, matched_transaction_id: 'tx-pay', created_journal_entry_id: 'je-pay' })
      return { ok: true, data: {} }
    })
    expect(await followReceiptsOfSupplierInvoice(ctx, 'si-1')).toEqual([{ status: 'completed', journal_entry_id: 'je-pay', transaction_id: 'tx-pay' }])
    expect(matchInboxItemTransaction).toHaveBeenCalledWith(ctx, 'receipt', 'tx-pay')
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['created_supplier_invoice_id', 'si-1'])
  })

  it('still unpaid: the receipt waits with the invoice, nothing written', async () => {
    const { ctx, payloads } = setup({ created_supplier_invoice_id: 'si-1' }, [])
    expect(await followReceiptsOfSupplierInvoice(ctx, 'si-1')).toEqual([{ status: 'waiting', reason: 'invoice_unpaid' }])
    expect(payloads('invoice_inbox_items', 'update')).toEqual([])
  })

  it('a supplier invoice registered from no inbox item has nothing to follow', async () => {
    const { ctx } = setup({})
    expect(await followReceiptsOfSupplierInvoice(ctx, 'si-other')).toEqual([])
  })

  it('a failed read of the items throws to the event consumer instead of a warning nobody reads', async () => {
    const mock = createTableMockSupabase({ invoice_inbox_items: { data: null, error: { message: 'statement timeout' } } })
    const ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: 'user-1', log }
    await expect(followReceiptsOfSupplierInvoice(ctx, 'si-1')).rejects.toThrow('could not be read: statement timeout')
  })
})

describe('the other way round, and a locked period (one half booked before pairs existed)', () => {
  it('a receipt booked first, its invoice still open: the invoice is added to the receipt\'s verifikat', async () => {
    const { ctx } = setup({}, [], { created_journal_entry_id: 'je-receipt' })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({
      ok: true,
      data: { status: 'completed', journal_entry_id: 'je-receipt', transaction_id: null },
    })
    expect(completeInboxItemOnEntry).toHaveBeenCalledWith(
      ctx.supabase,
      COMPANY,
      expect.objectContaining({ id: 'invoice', document_id: 'doc-invoice' }),
      'je-receipt',
      { basis: 'user_confirmed', evidence: { rule_id: 'inbox_receipt_pair:invoice_number' } },
    )
  })

  it('a receipt booked on its bank row, its invoice still open: the invoice joins the same row', async () => {
    const { rows, ctx } = setup({}, [], { matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-1']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      rows.set('invoice', { ...rows.get('invoice')!, matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
      return { ok: true, data: {} }
    })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({
      ok: true,
      data: { status: 'completed', journal_entry_id: 'je-1', transaction_id: 'tx-x' },
    })
    expect(matchInboxItemTransaction).toHaveBeenCalledWith(ctx, 'invoice', 'tx-x')
  })

  it('a receipt still open, its invoice registered and paid: the receipt joins the payment\'s row', async () => {
    const { rows, ctx } = setup({ created_supplier_invoice_id: 'si-paid' }, [{ transaction_id: 'tx-pay' }])
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-pay', 'je-pay']]))
    matchInboxItemTransaction.mockImplementation(async () => {
      rows.set('receipt', { ...rows.get('receipt')!, matched_transaction_id: 'tx-pay', created_journal_entry_id: 'je-pay' })
      return { ok: true, data: {} }
    })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toMatchObject({ ok: true, data: { status: 'completed', journal_entry_id: 'je-pay' } })
  })

  it('the booked half\'s verifikat in a locked period: nothing is written, and the answer says why', async () => {
    lockedJournalEntryIds.mockResolvedValue(new Set(['je-receipt', 'je-1']))
    const own = setup({}, [], { created_journal_entry_id: 'je-receipt' })
    expect(await followInvoiceWithReceipt(own.ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'waiting', reason: 'entry_locked' } })
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
    const onRow = setup({}, [], { matched_transaction_id: 'tx-x', created_journal_entry_id: 'je-1' })
    resolveBookedJournalEntryIds.mockResolvedValue(new Map([['tx-x', 'je-1']]))
    expect(await followInvoiceWithReceipt(onRow.ctx, 'invoice', 'receipt')).toEqual({ ok: true, data: { status: 'waiting', reason: 'entry_locked' } })
    // Not even the match: a locked verifikat leaves the open half exactly as it was.
    expect(matchInboxItemTransaction).not.toHaveBeenCalled()
    expect(onRow.payloads('invoice_inbox_items', 'update')).toEqual([])
  })

  it('two halves with different amounts are no purchase: refused, nothing written', async () => {
    const { ctx } = setup({}, [], { created_journal_entry_id: 'je-receipt', extracted_data: { ...RECEIPT_READ, totals: { total: 90 } } })
    expect(await followInvoiceWithReceipt(ctx, 'invoice', 'receipt')).toEqual({ ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' })
    expect(completeInboxItemOnEntry).not.toHaveBeenCalled()
  })

  it('the server-side follow after a receipt is booked takes the open invoice along', async () => {
    const { ctx } = setup({}, [], { created_journal_entry_id: 'je-receipt' })
    expect(await followPairedReceipt(ctx, 'receipt')).toEqual({ status: 'completed', journal_entry_id: 'je-receipt', transaction_id: null })
  })
})
