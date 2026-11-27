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
import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase, enqueueBankLinkLeg } from '@/tests/helpers'

// The learner is tested in ./link-learning.test.ts; here only that this door
// hands it the pair it linked (crm#1746).
const { learnSpy } = vi.hoisted(() => ({ learnSpy: vi.fn(async () => ({ outcome: 'learned' })) }))
vi.mock('@/lib/transactions/link-learning', () => ({ learnFromBankLink: learnSpy }))

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
    enqueueBankLinkLeg(enqueue, -800)
    enqueue({ data: null, error: { code, message: 'bank link rejected' } })
    expect(await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1',
    })).toMatchObject({ ok: false, code: code === 'PT409' ? 'CONFLICT' : 'LINK_TX_DB_ERROR' })
    expect(findCalls('transactions', 'update')).toHaveLength(1)
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_payments')
    expect(supabase.from).not.toHaveBeenCalledWith('payment_match_log')
  })

  it('names a voucher that books the bank ledger the wrong way before the write, with the way through (crm#1583)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: base, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue) // in debet only, for a payout of 800
    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
    expect(JSON.stringify(outcome)).toContain('bokför inget uttag (kredit) på 1930')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('names the guard refusing at the write (the verifikat changed since the read) instead of a generic conflict', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: base, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue, -800)
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
  const run = (
    voucher: { lines: unknown[] } & Record<string, unknown>,
    side: Record<string, string>,
    invoiceOverrides: Record<string, unknown> = {},
  ) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const { lines, ...entry } = voucher
    enqueue({ data: tx, error: null })
    enqueue({ data: entry, error: null })
    enqueueBankLinkLeg(enqueue, 1250)
    enqueue({ data: { ...invoice, ...invoiceOverrides }, error: null })
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

  it('refuses a credit note imported without a link, as the match doors do', async () => {
    expect(await run(revenueVoucher, BANK_DEBIT, { total: -500 }).outcome)
      .toMatchObject({ ok: false, code: 'LINK_TX_INVOICE_CREDIT_NOTE' })
  })

  it('refuses an original with an active credit note, as the match doors do, and a cancelled or half-created one does not count', async () => {
    const live = { id: 'cn-1', status: 'sent', creation_complete: true }
    expect(await run(revenueVoucher, BANK_DEBIT, { credit_notes: [live] }).outcome)
      .toMatchObject({ ok: false, code: 'LINK_TX_INVOICE_CREDIT_NOTE' })

    for (const creditNote of [{ ...live, status: 'cancelled' }, { ...live, creation_complete: false }]) {
      expect(await run(revenueVoucher, BANK_DEBIT, { credit_notes: [creditNote] }).outcome)
        .not.toMatchObject({ code: 'LINK_TX_INVOICE_CREDIT_NOTE' })
    }
  })

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

describe("linkTransactionToJournalEntry: the verifikat's bank leg must have room for the row (GitHub #3507)", () => {
  // A second Swish payment of 2 800 against the verifikat whose 1930 line
  // (2 800) a first payment already settles: the MCP link tool linked it and
  // the row showed as booked while its sale was never booked.
  const rowB = {
    id: 'tx-b', date: '2026-10-01', amount: 2800, currency: 'SEK', exchange_rate: null,
    cash_account_id: null, journal_entry_id: null, invoice_id: null, is_business: null, is_ignored: false,
    potential_invoice_id: null, potential_supplier_invoice_id: null,
  }
  const voucher = { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 17, entry_date: '2026-10-05' }

  function run(pointers: unknown[], options: { dryRun?: boolean } = {}) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rowB, error: null })
    enqueue({ data: voucher, error: null })
    enqueue({ data: [], error: null }) // cash_accounts in the row's currency: none, so 1930
    enqueue({ data: [{ account_number: '1930', debit_amount: 2800, credit_amount: 0 }], error: null })
    enqueue({ data: [], error: null }) // bank_line slices
    enqueue({ data: pointers, error: null }) // pointers
    enqueue({ data: [{ id: 'tx-b' }], error: null }) // the locked UPDATE, if it got that far
    return {
      findCalls,
      outcome: linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
        transactionId: 'tx-b', journalEntryId: 'je-1',
      }, options),
    }
  }

  it.each([false, true])('refuses the second row with VOUCHER_BANK_LEG_CONSUMED and what is left (dry run: %s)', async (dryRun) => {
    const { outcome, findCalls } = run(
      [{ id: 'tx-a', journal_entry_id: 'je-1', amount: 2800, currency: 'SEK', cash_account_id: null }],
      { dryRun },
    )
    expect(await outcome).toEqual({
      ok: false,
      code: 'VOUCHER_BANK_LEG_CONSUMED',
      details: {
        reason: expect.stringContaining('Verifikat A17 bokför 2800 på 1930'),
        booked: 2800,
        held: 2800,
        remaining: 0,
      },
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('counts a row bound to the ledger a legacy row without a cash account settles on', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rowB, error: null }) // cash_account_id null: settles on the resolved ledger
    enqueue({ data: voucher, error: null })
    enqueue({ data: [], error: null }) // cash_accounts in the row's currency: none, so 1930
    enqueue({ data: [{ account_number: '1930', debit_amount: 2800, credit_amount: 0 }], error: null })
    enqueue({ data: [], error: null }) // bank_line slices
    enqueue({ data: [{ id: 'tx-a', journal_entry_id: 'je-1', amount: 2800, currency: 'SEK', cash_account_id: 'ca-1930' }], error: null })
    enqueue({ data: { id: 'ca-1930' }, error: null }) // the cash account of 1930
    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-b', journalEntryId: 'je-1',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'VOUCHER_BANK_LEG_CONSUMED' })
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['ledger_account', '1930'])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('links the row when nobody else holds the bank leg', async () => {
    const { outcome } = run([])
    expect(await outcome).toMatchObject({ ok: true, result: { journalEntryId: 'je-1', voucherLabel: 'A-17' } })
  })

  it('teaches the bank text from the verifikat the caller named, at once (crm#1746)', async () => {
    learnSpy.mockClear()
    const { outcome } = run([])
    expect(await outcome).toMatchObject({ ok: true })
    expect(learnSpy).toHaveBeenCalledWith(expect.anything(), 'company-1', { transactionId: 'tx-b', journalEntryId: 'je-1' }, 'explicit')
  })

  it('teaches nothing from a dry run (crm#1746)', async () => {
    learnSpy.mockClear()
    const { outcome } = run([], { dryRun: true })
    expect(await outcome).toMatchObject({ ok: true, dryRun: true })
    expect(learnSpy).not.toHaveBeenCalled()
  })
})

describe('linkTransactionToJournalEntry: the payment plan', () => {
  const row = {
    id: 'tx-1',
    date: '2026-06-11',
    amount: 1500,
    currency: 'SEK',
    exchange_rate: null,
    journal_entry_id: null,
    invoice_id: null,
    is_business: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
  }
  const invoice = {
    id: 'inv-1',
    status: 'sent',
    total: 1000,
    paid_amount: 0,
    remaining_amount: 1000,
    currency: 'SEK',
    exchange_rate: null,
    paid_at: null,
    invoice_number: 'F-1',
    credited_invoice_id: null,
  }

  it('refuses a bank row larger than what the invoice owes, before anything is written', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: row, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue, 1500)
    enqueue({ data: invoice, error: null })
    enqueue({ data: { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }, error: null })
    enqueue({ data: [{ account_number: '1510', debit_amount: 0, credit_amount: 1500 }], error: null })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1', invoiceId: 'inv-1',
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      details: { remaining_amount: 1000, excess: 500 },
    })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('transactions', 'update')).toHaveLength(0)
  })

  // An invoice of 999,75 whose own verifikat booked 1510 at 1 000 and the öre
  // on 3740; the bank row and the verifikat clear 1 000. Real Postgres covers
  // the settlement itself (tests/pg/link-bank-row-voucher-booked-ore.pg.test.ts);
  // here what keeps the strict plan.
  const rounded = { ...invoice, total: 999.75, remaining_amount: 999.75, journal_entry_id: 'je-issue' }
  const roundedRow = { ...row, amount: 1000 }
  const queueTo = (enqueue: (r: { data?: unknown; error?: unknown }) => void, lines: unknown[]) => {
    enqueue({ data: roundedRow, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted', voucher_series: 'A', voucher_number: 1 }, error: null })
    enqueueBankLinkLeg(enqueue, 1000)
    enqueue({ data: rounded, error: null })
    enqueue({ data: { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }, error: null })
    enqueue({ data: lines, error: null })
  }
  const link = (supabase: unknown) =>
    linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1', journalEntryId: 'je-1', invoiceId: 'inv-1',
    }, { dryRun: true })

  it('settles a rounded invoice in full when the row and the verifikat clear what 1510 carries', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [{ account_number: '1510', debit_amount: 0, credit_amount: 1000 }])
    enqueue({ data: { ok: true, sek: 1000 }, error: null }) // document_carried_sek
    enqueue({ data: [], error: null }) // payment rows on the verifikat

    expect(await link(supabase)).toMatchObject({
      ok: true,
      dryRun: true,
      result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 },
    })
  })

  it('plans against the remainder when what 1510 carries cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [{ account_number: '1510', debit_amount: 0, credit_amount: 1000 }])
    enqueue({ data: null, error: { message: 'statement timeout' } }) // document_carried_sek

    expect(await link(supabase)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })

  it("plans against the remainder when another invoice's row already uses the verifikat's 151x credit", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [{ account_number: '1510', debit_amount: 0, credit_amount: 1000 }])
    enqueue({ data: { ok: true, sek: 1000 }, error: null }) // document_carried_sek
    enqueue({ data: [{ invoice_id: 'inv-other', amount: 400, currency: 'SEK' }], error: null })

    expect(await link(supabase)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })

  it("settles in full when another invoice's row uses part of the verifikat and the rest is what 1510 carries", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      { account_number: '1510', debit_amount: 0, credit_amount: 400 },
    ])
    enqueue({ data: { ok: true, sek: 1000 }, error: null }) // document_carried_sek
    enqueue({ data: [{ invoice_id: 'inv-other', amount: 400, currency: 'SEK' }], error: null })

    expect(await link(supabase)).toMatchObject({
      ok: true,
      result: { invoiceStatus: 'paid', paidAmount: 999.75, remainingAmount: 0 },
    })
  })

  it('plans against the remainder when the invoice already has a row on the verifikat: what 1510 carries already counts it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [{ account_number: '1510', debit_amount: 0, credit_amount: 1000 }])
    enqueue({ data: { ok: true, sek: 1000 }, error: null }) // document_carried_sek
    enqueue({ data: [{ invoice_id: 'inv-1', amount: 500, currency: 'SEK' }], error: null })

    expect(await link(supabase)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })

  it("does not count a 1513 credit (Skatteverket's ROT/RUT share) as clearing what 1510 carries", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    queueTo(enqueue, [
      { account_number: '1510', debit_amount: 0, credit_amount: 400 },
      { account_number: '1513', debit_amount: 0, credit_amount: 600 },
    ])
    enqueue({ data: { ok: true, sek: 1000 }, error: null }) // document_carried_sek
    enqueue({ data: [], error: null })

    expect(await link(supabase)).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
  })
})
