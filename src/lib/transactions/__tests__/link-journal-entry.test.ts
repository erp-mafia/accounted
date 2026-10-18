/**
 * Unit tests for hasLiveJournalEntryLink.
 *
 * This is the predicate the re-booking guards (linkTransactionToJournalEntry,
 * manualLink, categorize-core, the MCP stage-check) share to decide whether a
 * transaction's journal_entry_id is a LIVE link that should block re-linking,
 * or a stale pointer at a reversed/cancelled entry that the UI already shows as
 * "utan koppling" and must stay re-linkable (issue #988).
 *
 * The end-to-end re-link behaviour is covered by the route test
 * (app/api/transactions/[id]/link-journal-entry/__tests__/route.test.ts) and
 * the pending-op commit test.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase, enqueueBankLinkLeg } from '@/tests/helpers'
import { hasLiveJournalEntryLink, linkTransactionToJournalEntry } from '../link-journal-entry'

describe('hasLiveJournalEntryLink', () => {
  it('returns false for a null/undefined pointer without querying', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', null)).toBe(false)
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', undefined)).toBe(false)
  })

  it('returns true when the entry is posted (a live link)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'posted' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(true)
  })

  it('returns false when the entry is reversed (stale link, #988)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'reversed' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(false)
  })

  it('returns false when the entry is cancelled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'cancelled' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(false)
  })

  it('returns false when the referenced entry row is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-gone')).toBe(false)
  })

  it('fails closed (returns true) on a read error so a live link is never clobbered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout' } })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(true)
  })
})

describe('linkTransactionToJournalEntry: junction-row guard (#1553)', () => {
  const base = {
    id: 'tx-1',
    date: '2026-06-11',
    amount: -800,
    currency: 'SEK',
    exchange_rate: null,
    journal_entry_id: null,
    invoice_id: null,
    is_business: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
  }

  it.each(['PT409', 'XX000'])('returns the correct failure for %s before any payment effects', async code => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: base, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueue({ data: null, error: { code, message: 'bank link rejected' } })
    expect(await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1',
    })).toMatchObject({ ok: false, code: code === 'PT409' ? 'CONFLICT' : 'LINK_TX_DB_ERROR' })
    expect(findCalls('transactions', 'update')).toHaveLength(1)
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_payments')
    expect(supabase.from).not.toHaveBeenCalledWith('payment_match_log')
  })

  it('names a voucher that books the bank ledger the wrong way instead of a generic conflict', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: base, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueue({ data: null, error: { code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' } })
    expect(await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1',
    })).toMatchObject({ ok: false, code: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
  })

  it('refuses a transaction anchored through a bank_line junction row (1:N split, bulk-book) even though the pointer is NULL', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: { ...base, transaction_voucher_links: [{ journal_entry_id: 'je-split-a', role: 'bank_line' }] },
      error: null,
    })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1',
      journalEntryId: 'je-other',
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: 'je-split-a' },
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('lets a residual booking\'s "other" row through: the row must stay re-linkable after a storno of its main verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { ...base, transaction_voucher_links: [{ journal_entry_id: 'je-residual', role: 'other' }] },
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } }) // the verifikat lookup that follows the guard

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1',
      journalEntryId: 'je-other',
    })

    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).not.toBe('LINK_TX_TX_ALREADY_LINKED')
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
  })
})

// Review of #3440: this door wrote an invoice_payments row against any posted
// verifikat. For a kontantmetod invoice carried over the year end (linked, so
// it settles on the 151x credit) a revenue-and-moms voucher declared the moms
// a second time and left 1510 open.
describe('linkTransactionToJournalEntry: the invoice settlement side (#3440)', () => {
  const tx = {
    id: 'tx-1', date: '2027-02-15', amount: 1250, currency: 'SEK', exchange_rate: null,
    journal_entry_id: null, invoice_id: null, is_business: null,
    potential_invoice_id: null, potential_supplier_invoice_id: null,
  }
  const invoice = {
    id: 'inv-1', status: 'sent', total: 1250, paid_amount: 0, remaining_amount: 1250,
    currency: 'SEK', exchange_rate: null, paid_at: null, invoice_number: 'F-1', credited_invoice_id: null,
  }
  const revenueVoucher = {
    id: 'je-1', status: 'posted', voucher_series: 'B', voucher_number: 4, entry_date: '2027-02-15',
    lines: [
      { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
    ],
  }
  const run = (voucher: { lines: unknown[] } & Record<string, unknown>, side: Record<string, string>) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const { lines, ...entry } = voucher
    enqueue({ data: tx, error: null })
    enqueue({ data: entry, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueue({ data: invoice, error: null })
    enqueue({ data: side, error: null }) // invoice_settlement_side
    enqueue({ data: lines, error: null }) // the voucher's lines on that side
    return {
      findCalls,
      outcome: linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
        transactionId: 'tx-1', journalEntryId: 'je-1', invoiceId: 'inv-1',
      }, { dryRun: true }),
      supabase,
    }
  }
  const AR_CREDIT = { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }
  const BANK_DEBIT = { settlement_side: 'bank_debit', account_prefix: '19', entry_side: 'debit' }

  it('refuses a carried invoice (151x credit side) against a revenue-and-moms voucher, writing nothing', async () => {
    const { outcome, findCalls, supabase } = run(revenueVoucher, AR_CREDIT)
    expect(await outcome).toEqual({
      ok: false,
      code: 'LINK_TX_INVOICE_SETTLEMENT_SIDE',
      details: { settlementSide: 'ar_credit', accountPrefix: '151', entrySide: 'credit' },
    })
    expect(supabase.rpc).toHaveBeenCalledWith('invoice_settlement_side', { p_invoice_id: 'inv-1', p_company_id: 'company-1' })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_payments')
  })

  it('still links the same voucher for a kontantmetod invoice never booked (19xx debit side)', async () => {
    const { outcome } = run(revenueVoucher, BANK_DEBIT)
    expect(await outcome).toMatchObject({ ok: true, dryRun: true, result: { invoiceStatus: 'paid' } })
  })

  it('links a carried invoice to its clearing (Dr 1930 / Cr 1510)', async () => {
    const { outcome } = run({
      ...revenueVoucher,
      lines: [
        { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1250 },
      ],
    }, AR_CREDIT)
    expect(await outcome).toMatchObject({ ok: true, dryRun: true })
  })
})
