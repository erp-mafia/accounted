import { describe, it, expect } from 'vitest'
import { dropProposedLedgerDuplicates } from '../overview-rows'
import type { ReconciliationItem, ReconciliationProposal } from '../schemas'

function bankRow(
  id: string,
  bucket: ReconciliationItem['bucket'],
  proposal: ReconciliationProposal | null = null,
  amount = -1250,
): ReconciliationItem {
  return {
    item_id: id,
    item_type: 'transaction',
    side: 'external',
    bucket,
    date: '2026-08-02',
    description: 'KORTKÖP',
    amount,
    currency: 'SEK',
    proposal,
    actions: bucket === 'proposed' ? ['match', 'book', 'ignore'] : ['book', 'match', 'ignore'],
  }
}

function ledgerRow(entryId: string, voucherNumber: number, amount = -1250): ReconciliationItem {
  return {
    item_id: entryId,
    item_type: 'journal_entry',
    side: 'ledger',
    bucket: 'unmatched_ledger',
    date: '2026-08-03',
    description: `Verifikat ${voucherNumber}`,
    amount,
    currency: 'SEK',
    voucher_number: voucherNumber,
    voucher_series: 'A',
    entry_status: 'posted',
    actions: ['match', 'review'],
  }
}

function proposalFor(entryId: string, extra: Partial<ReconciliationProposal> = {}): ReconciliationProposal {
  return {
    journal_entry_id: entryId,
    voucher_number: 12,
    voucher_series: 'A',
    entry_date: '2026-08-03',
    description: 'Kontorsvaror',
    entry_status: 'posted',
    confidence: 0.85,
    reasons: ['auto_date_range'],
    ...extra,
  }
}

function setVoucher(entryId: string, voucherNumber: number, amount: number) {
  return { journal_entry_id: entryId, voucher_number: voucherNumber, voucher_series: 'A', entry_date: '2026-07-31', description: `Verifikat ${voucherNumber}`, amount }
}

const ids = (items: ReconciliationItem[]) => items.map((i) => i.item_id)

describe('dropProposedLedgerDuplicates', () => {
  it('lists a verifikat proposed 1:1 for a bank row only in its pair, and keeps every other ledger row', () => {
    const items = [
      bankRow('t-prop', 'proposed', proposalFor('e-2')),
      bankRow('t-open', 'unmatched_external'),
      ledgerRow('e-2', 12),
      ledgerRow('e-3', 13),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-prop', 't-open', 'e-3'])
  })

  it('keeps the ledger row of a verifikat whose net on the account differs from the proposed bank row', () => {
    // A multi-line verifikat: the matcher paired one 500 line, but the
    // verifikat nets -800 on the account. Its ledger row is the only place
    // the overview shows the 300 the pair does not explain.
    const items = [bankRow('t-prop', 'proposed', proposalFor('e-12'), -500), ledgerRow('e-12', 12, -800)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-prop', 'e-12'])
    // One öre off is a gap too.
    const ore = [bankRow('t-prop', 'proposed', proposalFor('e-12'), -500), ledgerRow('e-12', 12, -500.01)]
    expect(ids(dropProposedLedgerDuplicates(ore))).toEqual(['t-prop', 'e-12'])
  })

  it('drops a verifikat proposed for two bank rows once, when the rows together equal its net', () => {
    const items = [
      bankRow('t-a', 'proposed', proposalFor('e-20'), -300.1),
      bankRow('t-b', 'proposed', proposalFor('e-20'), -499.9),
      ledgerRow('e-20', 20, -800),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-a', 't-b'])
    // Rows that do not add up keep it listed.
    const short = [bankRow('t-a', 'proposed', proposalFor('e-20'), -300), bankRow('t-b', 'proposed', proposalFor('e-20'), -400), ledgerRow('e-20', 20, -800)]
    expect(ids(dropProposedLedgerDuplicates(short))).toEqual(['t-a', 't-b', 'e-20'])
  })

  it('drops the 1630 verifikat of a combined skattekonto proposal once, when the group equals its net', () => {
    // Two Skatteverket rows (avdragen skatt, arbetsgivaravgift) settle one
    // combined 1630 credit; each row carries the same proposal.
    const group = proposalFor('e-30', { reasons: ['summan av 2 händelser är exakt beloppet på 1630'], external_ids: ['s-1', 's-2'] })
    const skvRow = (id: string, amount: number): ReconciliationItem => ({
      ...bankRow(id, 'proposed', group, amount),
      item_type: 'skattekonto_transaction',
    })
    const items = [skvRow('s-1', -4210), skvRow('s-2', -3142.8), ledgerRow('e-30', 30, -7352.8), ledgerRow('e-31', 31, -900)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['s-1', 's-2', 'e-31'])
    // With one row of the group outside the list the sum is partial: keep it.
    expect(ids(dropProposedLedgerDuplicates([items[0], items[2]]))).toEqual(['s-1', 'e-30'])
  })

  it('drops every verifikat of a covering-set proposal, signing each bank leg in the row direction', () => {
    const outgoing = proposalFor('e-57', {
      reasons: ['exact_sum_same_date'],
      vouchers: [setVoucher('e-57', 57, 600), setVoucher('e-58', 58, 400)],
    })
    const items = [
      bankRow('t-bg', 'proposed', outgoing, -1000),
      ledgerRow('e-57', 57, -600),
      ledgerRow('e-58', 58, -400),
      ledgerRow('e-59', 59, -400),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-bg', 'e-59'])

    const incoming = proposalFor('e-60', {
      reasons: ['exact_sum_same_date'],
      vouchers: [setVoucher('e-60', 60, 25750), setVoucher('e-61', 61, 62500)],
    })
    const inItems = [bankRow('t-in', 'proposed', incoming, 88250), ledgerRow('e-60', 60, 25750), ledgerRow('e-61', 61, 62500)]
    expect(ids(dropProposedLedgerDuplicates(inItems))).toEqual(['t-in'])
  })

  it('keeps a set voucher whose net on the account differs from its bank leg', () => {
    // The voucher also has a debit line on the account, so it nets less than
    // the credit leg the set summed.
    const set = proposalFor('e-57', { vouchers: [setVoucher('e-57', 57, 600), setVoucher('e-58', 58, 400)] })
    const items = [bankRow('t-bg', 'proposed', set, -1000), ledgerRow('e-57', 57, -450), ledgerRow('e-58', 58, -400)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-bg', 'e-57'])
  })

  it('keeps the verifikat when the row pointing at it is not a live proposal (ignored or already matched)', () => {
    // A stale potential_journal_entry_id on an ignored row never gets linked:
    // the verifikat is still work on the ledger side.
    const items = [
      bankRow('t-ign', 'ignored', proposalFor('e-2')),
      bankRow('t-link', 'matched', proposalFor('e-3')),
      ledgerRow('e-2', 12),
      ledgerRow('e-3', 13),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-ign', 't-link', 'e-2', 'e-3'])
  })

  it('never drops a bank row that shares an id with a proposed verifikat, only the ledger listing', () => {
    const items = [bankRow('t-prop', 'proposed', proposalFor('x-1')), bankRow('x-1', 'unmatched_external'), ledgerRow('x-1', 1)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-prop', 'x-1'])
    expect(dropProposedLedgerDuplicates(items).find((i) => i.item_id === 'x-1')?.side).toBe('external')
  })

  it('returns the list untouched when nothing is proposed', () => {
    const items = [bankRow('t-open', 'unmatched_external'), ledgerRow('e-2', 12)]
    expect(dropProposedLedgerDuplicates(items)).toBe(items)
    expect(dropProposedLedgerDuplicates([])).toEqual([])
  })
})
