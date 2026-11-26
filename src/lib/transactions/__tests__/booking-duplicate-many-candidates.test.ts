/**
 * The booking-time duplicate guard when the window holds many same-amount
 * rows: a price many customers pay, many Swish payments of one ticket price.
 *
 * Both detectors read the links of their candidates by id with `.in()`, and
 * supabase-js puts the ids in the GET query string. With a few hundred
 * candidates the gateway refused the read before PostgREST saw it, and the
 * errors were not read: the ledger scan took every candidate for an orphan
 * and warned about a duplicate that was not there, and the sibling scan lost
 * the anchors of bulk-booked rows and missed the one that was. The fake
 * gateway (tests/gateway-supabase.ts) refuses a URL past a self-hosted Kong's
 * 8 KB, the stricter of the two limits.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

// The detection module's log records, for the tests that say a read failed out loud.
const { detectionLogs } = vi.hoisted(() => ({ detectionLogs: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base = {}) =>
      module === 'transactions/booking-duplicate-detection'
        ? actual.createTestLogger(module, detectionLogs as never, base)
        : actual.createLogger(module, base),
  }
})

import { detectBookedDuplicateTransaction, detectLedgerDuplicateVoucher } from '../booking-duplicate-detection'

type Row = Record<string, unknown>

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const TARGET = uuid(1, 'ffffffff')
const BULK_ENTRY = uuid(9999, 'eeeeeeee')

beforeEach(() => {
  detectionLogs.length = 0
})

/**
 * `count` posted verifikat of 299 kr on 1930 on the target's day, each paid
 * by a customer through a bank row (an invoice payment that names it). The
 * `orphan` has no payment and sits five days off.
 */
function paidVerifikat(count: number, orphan?: number): Record<string, Row[]> {
  const journal_entries: Row[] = []
  const journal_entry_lines: Row[] = []
  const invoice_payments: Row[] = []
  for (let n = 1; n <= count; n++) {
    const id = uuid(n, 'eeeeeeee')
    journal_entries.push({
      id, company_id: COMPANY, entry_date: n === orphan ? '2026-03-25' : '2026-03-20', description: `Inbetalning ${n}`,
      voucher_series: 'A', voucher_number: n, status: 'posted', source_type: 'invoice_paid', source_id: null,
    })
    journal_entry_lines.push({ id: uuid(n, 'dddddddd'), journal_entry_id: id, account_number: '1930', debit_amount: 299, credit_amount: 0 })
    if (n !== orphan) {
      invoice_payments.push({ id: uuid(n, 'aaaaaaaa'), company_id: COMPANY, journal_entry_id: id, transaction_id: uuid(n, 'bbbbbbbb') })
    }
  }
  return { journal_entries, journal_entry_lines, invoice_payments }
}

const incoming = { id: TARGET, date: '2026-03-20', amount: 299, currency: 'SEK', cash_account_id: null, settlement_account: '1930' }

describe('detectLedgerDuplicateVoucher: many same-amount verifikat in the window', () => {
  it('reads the links of 250 candidates in requests the gateway takes, and calls none of them a duplicate', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(paidVerifikat(250))

    const twin = await detectLedgerDuplicateVoucher(supabase, COMPANY, incoming)

    expect(twin).toBeNull()
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('invoice_payments').map((r) => inListOf(r, 'journal_entry_id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })

  it('finds the one unlinked verifikat among 250, though it sits farther off than the linked ones', async () => {
    const { supabase, unmodelled } = createGatewaySupabase(paidVerifikat(250, 250))

    const twin = await detectLedgerDuplicateVoucher(supabase, COMPANY, incoming)

    expect(twin).toMatchObject({ journal_entry_id: uuid(250, 'eeeeeeee'), voucher_label: 'A250', transaction_id: null })
    expect(unmodelled).toEqual([])
  })

  it('fails open, out loud, when a slice of the links cannot be read', async () => {
    let paymentReads = 0
    const { supabase } = createGatewaySupabase(paidVerifikat(250), {
      refuse: (request) => request.table === 'invoice_payments' && ++paymentReads === 2,
    })

    const twin = await detectLedgerDuplicateVoucher(supabase, COMPANY, incoming)

    expect(twin).toBeNull()
    expect(detectionLogs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'ledger duplicate links unreadable: no duplicate warning shown',
    }))
  })
})

/** A bank row of 50 kr with no verifikat pointer of its own: its anchor is a voucher link. */
const swish = (n: number, date: string): Row => ({
  id: uuid(n, 'cccccccc'), company_id: COMPANY, date, amount: -50, currency: 'SEK', amount_sek: null, exchange_rate: null,
  description: 'Swish', cash_account_id: null, journal_entry_id: null, is_booked: true, external_id: null,
  import_source: 'manual', bank_connection_id: null, provider_transaction_id: null, bank_file_import_id: null,
})
const link = (id: string, transactionId: string, journalEntryId: string): Row => ({
  id, company_id: COMPANY, transaction_id: transactionId, journal_entry_id: journalEntryId,
})
const bulkEntry = { id: BULK_ENTRY, company_id: COMPANY, voucher_series: 'A', voucher_number: 7, entry_date: '2026-03-20' }
const outgoing = { id: TARGET, date: '2026-03-20', amount: -50, currency: 'SEK', cash_account_id: null }

describe('detectBookedDuplicateTransaction: many bulk-booked siblings in the window', () => {
  it('reads the anchors of 300 siblings in requests the gateway takes, and flags the closest booked one', async () => {
    const siblings = Array.from({ length: 300 }, (_, i) => swish(i + 1, i === 299 ? '2026-03-20' : '2026-03-18'))
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      transactions: siblings,
      transaction_voucher_links: siblings.map((s, i) => link(uuid(i + 1, '11111111'), s.id as string, BULK_ENTRY)),
      journal_entries: [bulkEntry],
    })

    const twin = await detectBookedDuplicateTransaction(supabase, COMPANY, outgoing)

    expect(twin).toMatchObject({ transaction_id: uuid(300, 'cccccccc'), journal_entry_id: BULK_ENTRY, voucher_label: 'A7' })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('transaction_voucher_links').map((r) => inListOf(r, 'transaction_id').length)).toEqual([100, 100, 100])
    expect(unmodelled).toEqual([])
  })

  it('pages a slice whose anchors pass 1000 rows, so a split row\'s links do not hide another sibling\'s anchor', async () => {
    // Three split rows, booked across 499, 499 and 3 verifikat, fill the first
    // 1000 anchor rows; the closest sibling's one anchor sorts after them.
    const split = [1, 2, 3].map((n) => swish(n, '2026-03-17'))
    const closest = swish(4, '2026-03-20')
    const splitLinks = split.flatMap((s, k) =>
      Array.from({ length: [499, 499, 3][k] }, (_, i) => link(uuid(k * 1000 + i + 1, '10000000'), s.id as string, uuid(k * 1000 + i + 1, 'eeeeeeee'))),
    )
    const { supabase, unmodelled } = createGatewaySupabase({
      transactions: [...split, closest],
      transaction_voucher_links: [...splitLinks, link(uuid(1, 'f0000000'), closest.id as string, BULK_ENTRY)],
      journal_entries: [bulkEntry],
    })

    const twin = await detectBookedDuplicateTransaction(supabase, COMPANY, outgoing)

    expect(twin).toMatchObject({ transaction_id: closest.id, journal_entry_id: BULK_ENTRY })
    expect(unmodelled).toEqual([])
  })

  it('decides on the anchors it read, out loud, when a slice of them cannot be read', async () => {
    // A is booked through its own pointer; the bulk rows are anchored only in
    // transaction_voucher_links, and their second slice cannot be read. A
    // missing anchor can only hide a sibling, never make one: A is flagged.
    const ownEntry = uuid(1, '22222222')
    const booked: Row = { ...swish(9000, '2026-03-20'), journal_entry_id: ownEntry }
    const bulk = Array.from({ length: 300 }, (_, i) => swish(i + 1, '2026-03-18'))
    let linkReads = 0
    const { supabase } = createGatewaySupabase(
      {
        transactions: [booked, ...bulk],
        transaction_voucher_links: bulk.map((s, i) => link(uuid(i + 1, '11111111'), s.id as string, BULK_ENTRY)),
        journal_entries: [bulkEntry, { ...bulkEntry, id: ownEntry, voucher_number: 8 }],
      },
      { refuse: (request) => request.table === 'transaction_voucher_links' && ++linkReads === 2 },
    )

    const twin = await detectBookedDuplicateTransaction(supabase, COMPANY, outgoing)

    expect(twin).toMatchObject({ transaction_id: booked.id, journal_entry_id: ownEntry, voucher_label: 'A8' })
    expect(detectionLogs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'sibling anchors partly unreadable: deciding on the anchors read',
    }))
  })

  it('keeps the anchors of the reads that succeed when another read of the same slice fails', async () => {
    // Every payment-row read fails; the voucher links, read beside it, still
    // anchor the bulk-booked siblings, so the closest one is flagged.
    const siblings = Array.from({ length: 150 }, (_, i) => swish(i + 1, i === 149 ? '2026-03-20' : '2026-03-18'))
    const { supabase } = createGatewaySupabase(
      {
        transactions: siblings,
        transaction_voucher_links: siblings.map((s, i) => link(uuid(i + 1, '11111111'), s.id as string, BULK_ENTRY)),
        journal_entries: [bulkEntry],
      },
      { refuse: (request) => request.table === 'invoice_payments' },
    )

    const twin = await detectBookedDuplicateTransaction(supabase, COMPANY, outgoing)

    expect(twin).toMatchObject({ transaction_id: uuid(150, 'cccccccc'), journal_entry_id: BULK_ENTRY })
    expect(detectionLogs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'sibling anchors partly unreadable: deciding on the anchors read',
    }))
  })
})
