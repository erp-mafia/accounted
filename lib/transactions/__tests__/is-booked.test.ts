import { describe, it, expect } from 'vitest'
import {
  isTransactionBooked,
  getPrimaryJournalEntryId,
  getAllJournalEntryIds,
} from '../is-booked'

describe('isTransactionBooked', () => {
  it('returns false for a tx with no journal entry, payments, or voucher links', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    expect(isTransactionBooked(tx)).toBe(false)
    expect(isTransactionBooked(tx, [], [])).toBe(false)
  })

  it('returns true when transactions.journal_entry_id is set (1:1 case)', () => {
    const tx = { id: 'tx-1', journal_entry_id: 'je-1' }
    expect(isTransactionBooked(tx)).toBe(true)
  })

  it('returns true when a matching invoice_payments row exists (multi-allocation)', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-1' }]
    expect(isTransactionBooked(tx, payments)).toBe(true)
  })

  it('returns true when a matching supplier_invoice_payments row exists', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-1' }]
    expect(isTransactionBooked(tx, payments)).toBe(true)
  })

  it('returns true when a transaction_voucher_links row references the tx (bulk-book)', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const links = [{ transaction_id: 'tx-1' }]
    expect(isTransactionBooked(tx, [], links)).toBe(true)
  })

  it('ignores payment / voucher-link rows that reference a different tx', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-other' }]
    const links = [{ transaction_id: 'tx-other' }]
    expect(isTransactionBooked(tx, payments, links)).toBe(false)
  })
})

describe('getPrimaryJournalEntryId', () => {
  it('returns null when nothing is anchored', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    expect(getPrimaryJournalEntryId(tx)).toBeNull()
  })

  it('prefers transactions.journal_entry_id when set', () => {
    const tx = { id: 'tx-1', journal_entry_id: 'je-1' }
    const payments = [{ transaction_id: 'tx-1', journal_entry_id: 'je-payment' }]
    const links = [{ transaction_id: 'tx-1', journal_entry_id: 'je-link' }]
    expect(getPrimaryJournalEntryId(tx, payments, links)).toBe('je-1')
  })

  it('falls back to voucher-link when tx.journal_entry_id is null', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const links = [{ transaction_id: 'tx-1', journal_entry_id: 'je-link' }]
    expect(getPrimaryJournalEntryId(tx, [], links)).toBe('je-link')
  })

  it('falls back to invoice_payments JE when no link exists', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-1', journal_entry_id: 'je-payment' }]
    expect(getPrimaryJournalEntryId(tx, payments, [])).toBe('je-payment')
  })

  it('returns null when matching payment has journal_entry_id=null', () => {
    // Edge: an invoice_payments row that pre-dates the JE creation (the
    // engine's non-blocking JE write can leave this null briefly).
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-1', journal_entry_id: null }]
    expect(getPrimaryJournalEntryId(tx, payments, [])).toBeNull()
  })
})

describe('getAllJournalEntryIds', () => {
  it('returns an empty array for an unbooked transaction', () => {
    expect(getAllJournalEntryIds({ id: 'tx-1', journal_entry_id: null })).toEqual([])
  })

  it('returns every voucher link for a transaction split across verifikat', () => {
    // The case getPrimaryJournalEntryId cannot answer: one payment covering
    // several booked utlagg. Picking the first would state something untrue.
    const tx = { id: 'tx-1', journal_entry_id: null }
    const links = [
      { transaction_id: 'tx-1', journal_entry_id: 'je-a' },
      { transaction_id: 'tx-1', journal_entry_id: 'je-b' },
      { transaction_id: 'tx-1', journal_entry_id: 'je-c' },
    ]
    expect(getAllJournalEntryIds(tx, [], links)).toEqual(['je-a', 'je-b', 'je-c'])
  })

  it('ignores links and payments belonging to other transactions', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const links = [
      { transaction_id: 'tx-1', journal_entry_id: 'je-a' },
      { transaction_id: 'tx-2', journal_entry_id: 'je-other' },
    ]
    const payments = [{ transaction_id: 'tx-2', journal_entry_id: 'je-other-payment' }]
    expect(getAllJournalEntryIds(tx, payments, links)).toEqual(['je-a'])
  })

  it('leads with the same id getPrimaryJournalEntryId returns', () => {
    // The two helpers must never disagree about which entry is "first":
    // a UI showing a primary link plus a count would otherwise contradict itself.
    const tx = { id: 'tx-1', journal_entry_id: 'je-scalar' }
    const links = [{ transaction_id: 'tx-1', journal_entry_id: 'je-link' }]
    const all = getAllJournalEntryIds(tx, [], links)
    expect(all[0]).toBe(getPrimaryJournalEntryId(tx, [], links))
    expect(all).toEqual(['je-scalar', 'je-link'])
  })

  it('dedupes an entry reachable through more than one anchor', () => {
    // match_batch_allocate points every payment row at ONE combined verifikat,
    // so the same id legitimately arrives several times.
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [
      { transaction_id: 'tx-1', journal_entry_id: 'je-combined' },
      { transaction_id: 'tx-1', journal_entry_id: 'je-combined' },
    ]
    const links = [{ transaction_id: 'tx-1', journal_entry_id: 'je-combined' }]
    expect(getAllJournalEntryIds(tx, payments, links)).toEqual(['je-combined'])
  })

  it('skips a payment row whose journal_entry_id is still null', () => {
    const tx = { id: 'tx-1', journal_entry_id: null }
    const payments = [{ transaction_id: 'tx-1', journal_entry_id: null }]
    expect(getAllJournalEntryIds(tx, payments, [])).toEqual([])
  })
})
