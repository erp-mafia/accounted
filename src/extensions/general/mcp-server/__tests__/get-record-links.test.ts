/**
 * gnubok_get_record on a journal entry carries what is linked to it, each
 * link with its recorded basis (src/lib/links/voucher-links.ts). The reader
 * itself is tested in src/lib/links; here it is mocked so the tool contract
 * is what is pinned: the compact links, and links_unavailable (not an empty
 * list) when the lookup fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/links/voucher-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/links/voucher-links')>('@/lib/links/voucher-links')
  return { ...actual, getVoucherLinks: vi.fn() }
})
vi.mock('@/lib/suggestion-log/receipts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/suggestion-log/receipts')>('@/lib/suggestion-log/receipts')
  return { ...actual, getDecisionReceipts: vi.fn(async () => []) }
})

import { tools } from '../server'
import { getVoucherLinks, type VoucherLink } from '@/lib/links/voucher-links'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TX = '11111111-1111-4111-8111-111111111111'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const mockLinks = getVoucherLinks as ReturnType<typeof vi.fn>
const getRecord = tools.find((t) => t.name === 'gnubok_get_record')!

const NONE = {
  transaction_id: null,
  via: null,
  document_id: null,
  invoice_id: null,
  invoice_payment_id: null,
  supplier_invoice_id: null,
  supplier_invoice_payment_id: null,
  settlement_id: null,
} as const

function voucher() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { id: JE, voucher_series: 'A', voucher_number: 7, entry_date: '2026-10-16', description: 'Bankavgift' } })
  mock.enqueue({ data: [] }) // no documents
  return mock.supabase as unknown as SupabaseClient
}

beforeEach(() => {
  mockLinks.mockReset()
})

describe('gnubok_get_record journal_entry links', () => {
  it('answers each link compactly with its basis and evidence, read for this company and verifikat', async () => {
    const links: VoucherLink[] = [
      { ...NONE, kind: 'bank_transaction', transaction_id: TX, via: 'pointer', basis: 'agent_proposed_user_approved', evidence: { pending_operation_id: '22222222-2222-4222-8222-222222222222' } },
      { ...NONE, kind: 'document', document_id: DOC, basis: null, evidence: null },
    ]
    mockLinks.mockResolvedValue(links)
    const supabase = voucher()
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', supabase)) as { journal_entry: Record<string, unknown> }
    expect(mockLinks).toHaveBeenCalledWith(supabase, CO, JE)
    expect(out.journal_entry.links).toEqual([
      { kind: 'bank_transaction', transaction_id: TX, via: 'pointer', basis: 'agent_proposed_user_approved', evidence: { pending_operation_id: '22222222-2222-4222-8222-222222222222' } },
      // A link made before the basis was recorded says so: null, never a guess.
      { kind: 'document', document_id: DOC, basis: null },
    ])
    expect(out.journal_entry).not.toHaveProperty('links_unavailable')
    // No invoice, supplier invoice or skattekonto row booked by it: books is
    // left out, so it never reads as "this verifikat books nothing".
    expect(out.journal_entry).not.toHaveProperty('books')
  })

  it('names the invoice the verifikat books, as a record_ref to open next', async () => {
    mockLinks.mockResolvedValue([])
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: JE, voucher_series: 'A', voucher_number: 8, entry_date: '2026-10-16', description: 'Faktura 1001' } })
    mock.enqueue({ data: [] }) // no documents
    mock.enqueue({ data: [{ id: TX }] }) // invoices booked by it
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', mock.supabase as unknown as SupabaseClient)) as { journal_entry: Record<string, unknown> }
    expect(out.journal_entry.books).toEqual([{ relation: 'books', record_ref: `invoice:${TX}`, basis: null }])
  })

  it('answers the lines with account names, the status, the storno chain, the inline rättelser and both correction paths', async () => {
    mockLinks.mockResolvedValue([])
    const L1 = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e01'
    const L2 = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e02'
    const L3 = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e03'
    const ORIGINAL = '33333333-3333-4333-8333-333333333333'
    const RATTELSE = '44444444-4444-4444-8444-444444444444'
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: {
        id: JE, voucher_series: 'A', voucher_number: 7, entry_date: '2026-10-16', description: 'Programvara', status: 'posted',
        reverses_id: null, reversed_by_id: null, correction_of_id: ORIGINAL,
        // Out of order on purpose: the record answers them in sort_order.
        lines: [
          { id: L3, account_number: '1930', debit_amount: 0, credit_amount: 625, line_description: null, currency: 'SEK', amount_in_currency: null, sort_order: 2 },
          { id: L1, account_number: '5410', debit_amount: '500.00', credit_amount: 0, line_description: 'Licens', currency: 'SEK', amount_in_currency: null, sort_order: 0 },
          { id: L2, account_number: '2641', debit_amount: 125, credit_amount: 0, line_description: null, currency: 'SEK', amount_in_currency: null, sort_order: 1 },
        ],
      },
    })
    mock.enqueue({ data: [{ account_number: '5410', account_name: 'Förbrukningsinventarier' }, { account_number: '2641', account_name: 'Debiterad ingående moms' }, { account_number: '1930', account_name: 'Företagskonto' }] })
    mock.enqueue({ data: [] }) // no documents
    mock.enqueue({ data: [] }) // invoices booked by it
    mock.enqueue({ data: [] }) // supplier invoices registered by it
    mock.enqueue({ data: [] }) // supplier invoices paid by it
    mock.enqueue({ data: [] }) // skattekonto rows booked by it
    mock.enqueue({ data: [{ id: RATTELSE, rattelse_type: 'lines', created_at: '2026-10-17T08:00:00Z' }] })
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', mock.supabase as unknown as SupabaseClient)) as { journal_entry: Record<string, unknown> }

    expect(out.journal_entry.voucher).toBe('A7')
    expect(out.journal_entry.status).toBe('posted')
    expect(out.journal_entry.lines).toEqual([
      { line_id: L1, account_number: '5410', account_name: 'Förbrukningsinventarier', debit: 500, credit: 0, line_description: 'Licens' },
      { line_id: L2, account_number: '2641', account_name: 'Debiterad ingående moms', debit: 125, credit: 0, line_description: null },
      { line_id: L3, account_number: '1930', account_name: 'Företagskonto', debit: 0, credit: 625, line_description: null },
    ])
    // The names are read from this company's chart, for the verifikat's own accounts.
    expect(mock.findCall('chart_of_accounts', 'eq')).toEqual(['company_id', CO])
    expect(mock.findCall('chart_of_accounts', 'in')).toEqual(['account_number', ['5410', '2641', '1930']])
    expect(out.journal_entry.corrections).toEqual({
      reverses: null,
      reversed_by: null,
      correction_of: `journal_entry:${ORIGINAL}`,
      rattelser: [{ rattelse_id: RATTELSE, rattelse_type: 'lines', created_at: '2026-10-17T08:00:00Z' }],
    })
    expect(mock.findCalls('journal_entry_rattelse_log', 'eq')).toEqual([['company_id', CO], ['journal_entry_id', JE]])
    // Both rättelse paths are named on the record, not in a tool description.
    const hint = String(out.journal_entry.hint)
    for (const tool of ['gnubok_correct_entry_lines', 'gnubok_correct_entry_metadata', 'gnubok_correct_entry ', 'gnubok_search_tools']) expect(hint).toContain(tool)
    expect(hint).toMatch(/open, unlocked period after the company lock date/)
  })

  it('a reversed verifikat names its storno and carries no correction hint; failed name and rättelse lookups keep the record', async () => {
    mockLinks.mockResolvedValue([])
    const STORNO = '33333333-3333-4333-8333-333333333333'
    const L1 = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e01'
    const L2 = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e02'
    const timeout = { message: 'canceling statement due to statement timeout', code: '57014' }
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: {
        id: JE, voucher_series: 'A', voucher_number: 9, entry_date: '2026-10-16', description: 'Dubblett', status: 'reversed',
        reverses_id: null, reversed_by_id: STORNO, correction_of_id: null,
        lines: [
          { id: L1, account_number: '6570', debit_amount: 50, credit_amount: 0, line_description: null, currency: 'EUR', amount_in_currency: 4.5, sort_order: 0 },
          { id: L2, account_number: '1930', debit_amount: 0, credit_amount: 50, line_description: null, currency: null, amount_in_currency: null, sort_order: 1 },
        ],
      },
    })
    mock.enqueue({ data: null, error: timeout }) // account names
    mock.enqueue({ data: [] }) // no documents
    mock.enqueue({ data: [] }) // invoices booked by it
    mock.enqueue({ data: [] }) // supplier invoices registered by it
    mock.enqueue({ data: [] }) // supplier invoices paid by it
    mock.enqueue({ data: [] }) // skattekonto rows booked by it
    mock.enqueue({ data: null, error: timeout }) // rättelse log
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', mock.supabase as unknown as SupabaseClient)) as { journal_entry: Record<string, unknown> }

    expect(out.journal_entry.status).toBe('reversed')
    expect(out.journal_entry).not.toHaveProperty('hint')
    // A failed name lookup keeps the lines; a foreign-currency line says its currency.
    expect(out.journal_entry.lines).toEqual([
      { line_id: L1, account_number: '6570', account_name: null, debit: 50, credit: 0, line_description: null, currency: 'EUR', amount_in_currency: 4.5 },
      { line_id: L2, account_number: '1930', account_name: null, debit: 0, credit: 50, line_description: null },
    ])
    expect(out.journal_entry.corrections).toEqual({ reverses: null, reversed_by: `journal_entry:${STORNO}`, correction_of: null, rattelser_unavailable: true })
  })

  it('a failed link lookup keeps the record and says links_unavailable, never an empty list', async () => {
    mockLinks.mockRejectedValue(new Error('canceling statement due to statement timeout'))
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', voucher())) as { journal_entry: Record<string, unknown> }
    expect(out.journal_entry.voucher).toBe('A7')
    expect(out.journal_entry).not.toHaveProperty('links')
    expect(out.journal_entry.links_unavailable).toBe(true)
  })
})
