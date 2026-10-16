/**
 * Parity of the two "link a bank row to a verifikat" doors.
 *
 * manualLink (the reconciliation page and the account-keyed reconciliation)
 * and linkTransactionToJournalEntry (the duplicate-payment dialog, v1, MCP and
 * its approval) both run the bank link core (lib/transactions/bank-link.ts).
 * On the same rows they must accept and refuse the same pairs, and write the
 * same pointer. Before the core, linkTransactionToJournalEntry linked an
 * ignored row and a verifikat with no line on the row's bank account, which
 * the reconciliation page refuses, and the database then answered at the
 * write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { manualLink } from '@/lib/reconciliation/bank-reconciliation'
import { linkTransactionToJournalEntry } from '../link-journal-entry'

/** The basis a person's own link records (src/lib/links/link-basis.ts). */
const MANUAL = { linkBasis: { basis: 'user_confirmed' as const } }

vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn() }))

const COMPANY = 'company-1'
const USER = 'user-1'
const TX = 'tx-1'
const JE = 'je-1'

const freeRow = {
  id: TX,
  date: '2026-09-02',
  amount: -800,
  currency: 'SEK',
  exchange_rate: null,
  description: 'Hyra',
  merchant_name: null,
  cash_account_id: null,
  journal_entry_id: null,
  invoice_id: null,
  is_business: null,
  is_ignored: false,
  potential_invoice_id: null,
  potential_supplier_invoice_id: null,
  potential_rot_rut_payout_request_id: null,
  transaction_voucher_links: [],
}
const postedEntry = { id: JE, status: 'posted', voucher_series: 'A', voucher_number: 7, entry_date: '2026-09-02' }
const bankLine = { account_number: '1930', debit_amount: 0, credit_amount: 800 }

interface Case {
  name: string
  row: Record<string, unknown>
  entry: Record<string, unknown> | null
  lines: unknown[]
  /** manualLink's code, and linkTransactionToJournalEntry's, for the same refusal; null when both link. */
  codes: [string, string] | null
}

const CASES: Case[] = [
  { name: 'a free row and a verifikat with a line on 1930', row: freeRow, entry: postedEntry, lines: [bankLine], codes: null },
  {
    name: 'an ignored row',
    row: { ...freeRow, is_ignored: true },
    entry: postedEntry,
    lines: [bankLine],
    codes: ['TRANSACTION_IGNORED', 'LINK_TX_TX_IGNORED'],
  },
  {
    name: 'a verifikat with no line on the row\'s bank account',
    row: freeRow,
    entry: postedEntry,
    lines: [],
    codes: ['NOT_SETTLED', 'BANK_ANCHOR_SETTLEMENT_CHANGED'],
  },
  {
    name: 'a reversed verifikat',
    row: freeRow,
    entry: { ...postedEntry, status: 'reversed' },
    lines: [bankLine],
    codes: ['ENTRY_REVERSED', 'LINK_TX_JE_NOT_POSTED'],
  },
  {
    name: 'a draft',
    row: freeRow,
    entry: { ...postedEntry, status: 'draft' },
    lines: [bankLine],
    codes: ['ENTRY_NOT_POSTED', 'LINK_TX_JE_NOT_POSTED'],
  },
  {
    name: 'a missing verifikat',
    row: freeRow,
    entry: null,
    lines: [bankLine],
    codes: ['ENTRY_NOT_FOUND', 'LINK_TX_JE_NOT_FOUND'],
  },
  {
    name: 'a row already split over verifikat (bank_line junction rows)',
    row: { ...freeRow, transaction_voucher_links: [{ journal_entry_id: 'je-split', role: 'bank_line' }] },
    entry: postedEntry,
    lines: [bankLine],
    codes: ['TRANSACTION_ALREADY_LINKED', 'LINK_TX_TX_ALREADY_LINKED'],
  },
]

function mockFor(c: Case) {
  return createTableMockSupabase({
    transactions: [{ data: c.row }, { data: [{ id: TX }] }],
    journal_entries: c.entry ? { data: c.entry } : { data: null, error: { message: 'not found' } },
    // A row without a cash account settles on the company's one enabled
    // account in its currency, else 1930: none here, so 1930.
    cash_accounts: { data: [] },
    journal_entry_lines: { data: c.lines },
  })
}

describe('bank link parity: manualLink and linkTransactionToJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it.each(CASES)('$name', async (c) => {
    const reconciliation = mockFor(c)
    const manual = await manualLink(reconciliation.supabase as never, COMPANY, TX, JE, USER, '1930', MANUAL)

    const linkDoor = mockFor(c)
    const linked = await linkTransactionToJournalEntry(linkDoor.supabase as never, USER, COMPANY, {
      transactionId: TX,
      journalEntryId: JE,
    })

    if (c.codes === null) {
      expect(manual).toEqual({ success: true })
      expect(linked.ok).toBe(true)
      const [manualWrite] = reconciliation.findCalls('transactions', 'update')[0] as [Record<string, unknown>]
      const [linkWrite] = linkDoor.findCalls('transactions', 'update')[0] as [Record<string, unknown>]
      expect(manualWrite).toMatchObject({ journal_entry_id: JE, is_business: true })
      expect(linkWrite).toMatchObject({ journal_entry_id: JE, is_business: true })
      return
    }

    expect(manual).toMatchObject({ success: false, code: c.codes[0] })
    expect(linked).toMatchObject({ ok: false, code: c.codes[1] })
    expect(reconciliation.findCalls('transactions', 'update')).toEqual([])
    expect(linkDoor.findCalls('transactions', 'update')).toEqual([])
  })

  it('a dry run of linkTransactionToJournalEntry refuses the voucher with no bank line too', async () => {
    const c = CASES.find((x) => x.codes?.[0] === 'NOT_SETTLED')!
    const { supabase, findCalls } = mockFor(c)
    const outcome = await linkTransactionToJournalEntry(
      supabase as never,
      USER,
      COMPANY,
      { transactionId: TX, journalEntryId: JE },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('both doors move a row to the live sibling ledger its verifikat is booked on (#1643)', async () => {
    // The row sits on an orphaned reconnect row (1931); the verifikat books
    // the live ledger of the same physical account (1940).
    const orphan = {
      id: 'ca-orphan', company_id: COMPANY, ledger_account: '1931', currency: 'SEK', iban: 'SE4550000000058398257466',
      enabled: false, bank_connection_id: null,
    }
    const live = {
      id: 'ca-live', company_id: COMPANY, ledger_account: '1940', currency: 'SEK', iban: 'SE4550000000058398257466',
      enabled: true, bank_connection_id: 'conn-1',
    }
    const row = { ...freeRow, cash_account_id: 'ca-orphan' }
    const tables = () =>
      createTableMockSupabase({
        transactions: [{ data: row }, { data: [{ id: TX }] }],
        journal_entries: { data: postedEntry },
        // the row's own account (ledger, then the topology), read by either door
        cash_accounts: [{ data: { ledger_account: '1931', currency: 'SEK' } }, { data: [orphan, live] }],
        bank_connections: { data: [{ id: 'conn-1', status: 'active' }] },
        journal_entry_lines: { data: [{ account_number: '1940', debit_amount: 0, credit_amount: 800 }] },
      })

    const reconciliation = tables()
    expect(await manualLink(reconciliation.supabase as never, COMPANY, TX, JE, USER, '1931', MANUAL)).toEqual({ success: true })
    const linkDoor = tables()
    expect(
      (await linkTransactionToJournalEntry(linkDoor.supabase as never, USER, COMPANY, { transactionId: TX, journalEntryId: JE })).ok,
    ).toBe(true)

    for (const door of [reconciliation, linkDoor]) {
      const [write] = door.findCalls('transactions', 'update')[0] as [Record<string, unknown>]
      expect(write).toMatchObject({ journal_entry_id: JE, cash_account_id: 'ca-live' })
    }
  })
})
