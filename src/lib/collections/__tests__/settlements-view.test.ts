/**
 * What the settlements view reads: the payouts and collected payments with
 * their voucher numbers, invoice and customer, the provider's name, and for
 * one payout the choices a person must make before it books and the voucher
 * a possible duplicate already sits on.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemorySupabase, COMPANY_ID, type MemorySupabase } from './memory-supabase'
import { loadSettlementDetail, loadSettlementsOverview } from '../settlements-view'

const SETTLEMENT_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999999'

let db: MemorySupabase

function line(position: number, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `line-${position}`,
    company_id: COMPANY_ID,
    settlement_id: SETTLEMENT_ID,
    position,
    kind,
    in_payout: true,
    recipient: kind === 'principal' ? 'creditor' : 'agency',
    amount: 100,
    tax_amount: 0,
    provider_type: 'p',
    original_invoice_ids: [],
    account_number: null,
    vat_account_number: null,
    account_chosen_by: null,
    booked: false,
    ...extra,
  }
}

function settlement(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SETTLEMENT_ID,
    company_id: COMPANY_ID,
    connection_id: 'connection-1',
    provider_settlement_ref: '7731',
    payment_date: '2026-10-01',
    settlement_date: '2026-10-01',
    amount: 843.75,
    currency: 'SEK',
    provider_status_ok: true,
    bank_reference: 'PAYOUT 7731',
    status: 'needs_mapping',
    needs_mapping_reason: 'vat_unconfirmed',
    journal_entry_id: null,
    document_attachment_id: null,
    provider_acknowledged_at: null,
    ...extra,
  }
}

beforeEach(() => {
  db = createMemorySupabase()
})

describe('loadSettlementsOverview', () => {
  it('names vouchers, invoices, customers and the provider', async () => {
    db.seed('collection_connections', [
      { id: 'old', company_id: COMPANY_ID, state: 'disconnected', display_name: 'Old Agency', created_at: '2026-01-01T00:00:00Z' },
      { id: 'connection-1', company_id: COMPANY_ID, state: 'active', display_name: 'Acme Inkasso', created_at: '2026-09-01T00:00:00Z' },
    ])
    db.seed('collection_settlements', [settlement({ status: 'booked', needs_mapping_reason: null, journal_entry_id: 'je-d1' })])
    db.seed('collection_collected_payments', [
      { id: 'p1', company_id: COMPANY_ID, case_id: 'case-1', invoice_id: 'inv-1', provider_payment_ref: 'x', paid_at: '2026-09-27', capital_paid: 1000, to_agency: 0, status: 'booked', journal_entry_id: 'je-c1', settlement_id: SETTLEMENT_ID },
      { id: 'p2', company_id: COMPANY_ID, case_id: 'case-2', invoice_id: 'inv-2', provider_payment_ref: 'y', paid_at: '2026-09-28', capital_paid: 500, to_agency: 0, status: 'needs_review', review_reason: 'PERIOD_LOCKED' },
    ])
    db.seed('journal_entries', [
      { id: 'je-d1', company_id: COMPANY_ID, voucher_series: 'C', voucher_number: 12 },
      { id: 'je-c1', company_id: COMPANY_ID, voucher_series: 'c', voucher_number: 11 },
    ])
    db.seed('invoices', [
      { id: 'inv-1', company_id: COMPANY_ID, invoice_number: '1042', customer_id: 'cust-1' },
      { id: 'inv-2', company_id: COMPANY_ID, invoice_number: '1043', customer_id: null },
    ])
    db.seed('customers', [{ id: 'cust-1', company_id: COMPANY_ID, name: 'Kund AB' }])

    const overview = await loadSettlementsOverview(db.client, COMPANY_ID)

    expect(overview.provider).toBe('Acme Inkasso')
    expect(overview.settlements[0]).toMatchObject({ id: SETTLEMENT_ID, voucher: 'C12', status: 'booked' })
    const byId = new Map(overview.collectedPayments.map((p) => [p.id, p]))
    expect(byId.get('p1')).toMatchObject({ voucher: 'C11', invoiceNumber: '1042', customerName: 'Kund AB', settlementId: SETTLEMENT_ID })
    expect(byId.get('p2')).toMatchObject({ voucher: null, invoiceNumber: '1043', customerName: null, reviewReason: 'PERIOD_LOCKED' })
  })

  it('keeps the name of a disconnected provider and reads nothing of another company', async () => {
    db.seed('collection_connections', [{ id: 'old', company_id: COMPANY_ID, state: 'disconnected', display_name: 'Acme Inkasso', created_at: '2026-01-01T00:00:00Z' }])
    db.seed('collection_settlements', [settlement({ company_id: OTHER_COMPANY })])
    db.seed('journal_entries', [{ id: 'je-x', company_id: OTHER_COMPANY, voucher_series: 'C', voucher_number: 1 }])

    const overview = await loadSettlementsOverview(db.client, COMPANY_ID)

    expect(overview).toEqual({ provider: 'Acme Inkasso', settlements: [], collectedPayments: [] })
  })

  it('has no provider name without a connection', async () => {
    expect((await loadSettlementsOverview(db.client, COMPANY_ID)).provider).toBeNull()
  })

  it('lists every row Att göra counts, however old, beside the newest 200 of the rest', async () => {
    const day = (i: number) => `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`
    db.seed(
      'collection_settlements',
      Array.from({ length: 205 }, (_, i) =>
        settlement({ id: `s-${String(i).padStart(3, '0')}`, provider_settlement_ref: `r${i}`, payment_date: day(i + 30), status: 'booked', needs_mapping_reason: null }),
      ),
    )
    // Older than every booked payout: beyond the newest 200, still waiting for a person.
    db.seed('collection_settlements', [settlement({ id: 's-old', payment_date: '2025-12-01', status: 'needs_mapping' })])
    db.seed(
      'collection_collected_payments',
      Array.from({ length: 205 }, (_, i) => ({
        id: `p-${String(i).padStart(3, '0')}`,
        company_id: COMPANY_ID,
        case_id: 'case-1',
        invoice_id: 'inv-1',
        provider_payment_ref: `x${i}`,
        paid_at: day(i + 30),
        capital_paid: 100,
        to_agency: 0,
        status: 'booked',
      })),
    )
    db.seed('collection_collected_payments', [
      { id: 'p-old', company_id: COMPANY_ID, case_id: 'case-1', invoice_id: 'inv-1', provider_payment_ref: 'old', paid_at: '2025-11-01', capital_paid: 100, to_agency: 0, status: 'needs_review', review_reason: 'PERIOD_LOCKED' },
    ])

    const overview = await loadSettlementsOverview(db.client, COMPANY_ID)

    expect(overview.settlements).toHaveLength(201)
    expect(overview.settlements.at(-1)).toMatchObject({ id: 's-old', status: 'needs_mapping' })
    expect(overview.settlements[0]!.paymentDate >= overview.settlements[1]!.paymentDate).toBe(true)
    expect(overview.collectedPayments).toHaveLength(201)
    expect(overview.collectedPayments.at(-1)).toMatchObject({ id: 'p-old', status: 'needs_review' })
  })
})

describe('loadSettlementDetail', () => {
  it('marks the lines a person must place while the payout waits', async () => {
    db.seed('collection_settlements', [settlement()])
    db.seed('collection_settlement_lines', [
      line(0, 'principal', { account_number: '1689' }),
      line(1, 'agency_commission', { account_number: '6062', tax_amount: 25 }),
      line(2, 'unknown'),
      line(3, 'informational', { in_payout: false }),
      line(4, 'interest_to_creditor', { account_number: '8313' }),
    ])

    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)

    const choices = detail!.lines.map((l) => [l.position, l.needsAccount, l.needsVatAccount])
    expect(choices).toEqual([
      [0, null, false],
      [1, null, true],
      [2, 'any', false],
      [3, null, false],
      [4, null, false],
    ])
    expect(detail!.duplicateOf).toBeNull()
  })

  it('asks for the VAT line itself when the payout has one, and nothing once the person chose', async () => {
    db.seed('collection_settlements', [settlement()])
    db.seed('collection_settlement_lines', [
      line(0, 'agency_commission', { account_number: '6062', tax_amount: 25 }),
      line(1, 'agency_fee_vat'),
    ])
    let detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.lines.map((l) => [l.needsAccount, l.needsVatAccount])).toEqual([
      [null, false],
      ['vat', false],
    ])

    db.rows('collection_settlement_lines')[1]!.account_number = '2641'
    db.rows('collection_settlement_lines')[1]!.account_chosen_by = 'someone'
    detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.lines[1]).toMatchObject({ needsAccount: null, chosenByPerson: true, accountNumber: '2641' })
  })

  it('asks nothing of a payout that does not wait for a person', async () => {
    db.seed('collection_settlements', [settlement({ status: 'received', needs_mapping_reason: null })])
    db.seed('collection_settlement_lines', [line(0, 'unknown')])
    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.lines[0]).toMatchObject({ needsAccount: null, needsVatAccount: false })
  })

  /** A payout not yet attempted: a principal of the company's case and a commission with VAT, no VAT line. */
  function seedPayoutWorld(vatRegistered: boolean) {
    db.seed('collection_connections', [
      { id: 'connection-1', company_id: COMPANY_ID, route: 'connect', state: 'active', display_name: 'Acme Inkasso', clearing_account: '1689', payout_account: '1930' },
    ])
    db.seed('company_settings', [{ company_id: COMPANY_ID, vat_registered: vatRegistered }])
    db.seed('collection_collected_payments', [
      { id: 'cp-1', company_id: COMPANY_ID, case_id: 'case-1', invoice_id: 'inv-1', paid_at: '2026-09-27', capital_paid: 1000, status: 'booked', journal_entry_id: 'je-c1', settlement_id: null },
    ])
    db.seed('journal_entries', [{ id: 'je-c1', company_id: COMPANY_ID, status: 'posted', voucher_series: 'C', voucher_number: 4 }])
    db.seed('collection_settlements', [settlement({ status: 'received', needs_mapping_reason: null })])
    db.seed('collection_settlement_lines', [
      line(0, 'principal', { amount: 1000, case_id: 'case-1', invoice_id: 'inv-1' }),
      line(1, 'agency_commission', { amount: 125, tax_amount: 31.25 }),
    ])
  }

  it('shows where a payout not yet booked would put each line, and the voucher it would post', async () => {
    seedPayoutWorld(false)
    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.lines.map((l) => [l.accountNumber, l.vatAccountNumber, l.needsAccount, l.needsVatAccount, l.direction])).toEqual([
      ['1689', null, null, false, 'credit'],
      ['6062', '6062', null, false, 'debit'],
    ])
    expect(detail!.voucherPreview).toEqual([
      { accountNumber: '1930', debit: 843.75, credit: 0 },
      { accountNumber: '1689', debit: 0, credit: 1000 },
      { accountNumber: '6062', debit: 125, credit: 0 },
      { accountNumber: '6062', debit: 31.25, credit: 0 },
    ])
    // Nothing is recorded by reading it.
    expect(db.rows('collection_settlement_lines').map((l) => l.account_number)).toEqual([null, null])
  })

  it('asks on the first click for what the ledger cannot place on its own, and previews no voucher until then', async () => {
    seedPayoutWorld(true)
    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.lines.map((l) => [l.accountNumber, l.needsAccount, l.needsVatAccount])).toEqual([
      ['1689', null, false],
      ['6062', null, true],
    ])
    expect(detail!.voucherPreview).toBeNull()
  })

  it('shows the voucher a payout with fees will book, the VAT row waiting for the person\'s choice', async () => {
    seedPayoutWorld(true)
    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.voucherDraft).toEqual([
      { accountNumber: '1930', waitsFor: null, debit: 843.75, credit: 0 },
      { accountNumber: '1689', waitsFor: null, debit: 0, credit: 1000 },
      { accountNumber: '6062', waitsFor: null, debit: 125, credit: 0 },
      { accountNumber: null, waitsFor: { position: 1, field: 'vatAccount' }, debit: 31.25, credit: 0 },
    ])
  })

  it('gives the full voucher as the draft once nothing waits', async () => {
    seedPayoutWorld(false)
    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)
    expect(detail!.voucherDraft).toEqual(detail!.voucherPreview!.map((row) => ({ ...row, waitsFor: null })))
  })

  it('names the voucher a possible duplicate already sits on', async () => {
    db.seed('collection_settlements', [settlement({ needs_mapping_reason: 'possible_duplicate' })])
    db.seed('transactions', [
      { id: 't1', company_id: COMPANY_ID, date: '2026-10-02', amount: 843.75, description: 'Insättning PAYOUT 7731', original_description: null, journal_entry_id: 'je-hand' },
    ])
    db.seed('journal_entries', [{ id: 'je-hand', company_id: COMPANY_ID, voucher_series: 'A', voucher_number: 88 }])

    const detail = await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)

    expect(detail!.duplicateOf).toEqual({ journalEntryId: 'je-hand', voucher: 'A88' })
  })

  it('answers null for another company', async () => {
    db.seed('collection_settlements', [settlement({ company_id: OTHER_COMPANY })])
    expect(await loadSettlementDetail(db.client, COMPANY_ID, SETTLEMENT_ID)).toBeNull()
  })
})
