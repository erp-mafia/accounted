import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  isTransactionBooked,
  getPrimaryJournalEntryId,
  getLinkedJournalEntryIds,
  embeddedVoucherLabel,
  assertTransactionBookable,
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

describe('getLinkedJournalEntryIds', () => {
  it('returns an empty list for a row with no pointer and no junction rows', () => {
    expect(getLinkedJournalEntryIds({ journal_entry_id: null })).toEqual([])
    expect(getLinkedJournalEntryIds({ journal_entry_id: null, transaction_voucher_links: [] })).toEqual([])
  })

  it('lists the pointer first, then every bank_line junction verifikat, deduplicated (crm#48 split row)', () => {
    expect(
      getLinkedJournalEntryIds({
        journal_entry_id: null,
        transaction_voucher_links: [
          { journal_entry_id: 'je-200', role: 'bank_line' },
          { journal_entry_id: 'je-201', role: 'bank_line' },
          { journal_entry_id: 'je-200', role: 'bank_line' },
        ],
      }),
    ).toEqual(['je-200', 'je-201'])
    expect(
      getLinkedJournalEntryIds({
        journal_entry_id: 'je-1',
        transaction_voucher_links: [{ journal_entry_id: 'je-1', role: null }, { journal_entry_id: 'je-2' }],
      }),
    ).toEqual(['je-1', 'je-2'])
  })

  it('does not count supplementary roles as a booking of the bank line', () => {
    expect(
      getLinkedJournalEntryIds({
        journal_entry_id: null,
        transaction_voucher_links: [{ journal_entry_id: 'je-res', role: 'other' }, { journal_entry_id: 'je-clr', role: 'clearing' }],
      }),
    ).toEqual([])
  })
})

describe('embeddedVoucherLabel', () => {
  it('formats series and number, and returns null without an embedded voucher', () => {
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: 'V', voucher_number: 200 } })).toBe('V200')
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: null, voucher_number: 7 } })).toBe('7')
    expect(embeddedVoucherLabel({ journal_entry_id: 'x' })).toBeNull()
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: 'A', voucher_number: null } })).toBeNull()
  })
})

describe('assertTransactionBookable', () => {
  const TX = { id: 'tx-1', journal_entry_id: null as string | null }

  it('lets an unanchored row through after one links read (no pointer, no links)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // transaction_voucher_links
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
    expect(findCalls('transaction_voucher_links', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['transaction_id', 'tx-1'],
    ])
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('refuses a row anchored only by a bank_line link to a posted verifikat (bulk-book N>1, split)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-samling', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-samling', status: 'posted' }] })
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({
      ok: false,
      code: 'TRANSACTION_ALREADY_CATEGORIZED',
      journalEntryId: 'je-samling',
      via: 'link',
    })
  })

  it('refuses a row whose pointer names a posted verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    expect(
      await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-1' }),
    ).toEqual({ ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: 'je-1', via: 'pointer' })
  })

  it('reports bulk-book N=1 (pointer and link name the same verifikat) as one pointer booking', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-1', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    expect(
      await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-1' }),
    ).toEqual({ ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: 'je-1', via: 'pointer' })
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-1']]])
  })

  it('refuses a row a correction re-pointed onto the live correction verifikat', async () => {
    // relinkTransactionsToEntry moves the link from the reversed original to
    // the posted correction: the row is booked against the correction.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-correction', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-correction', status: 'posted' }] })
    const verdict = await assertTransactionBookable(supabase as never, 'company-1', TX)
    expect(verdict).toMatchObject({ ok: false, journalEntryId: 'je-correction', via: 'link' })
  })

  it('lets a row through when its pointer and link name a reversed verifikat (uncategorize, then rebook)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-old', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    expect(
      await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-old' }),
    ).toEqual({ ok: true })
  })

  it('ignores supplementary roles and never reads their verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-residual', role: 'other' }, { journal_entry_id: 'je-c', role: 'clearing' }] })
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('uses embedded links instead of re-reading them', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'je-split', status: 'posted' }] })
    const verdict = await assertTransactionBookable(supabase as never, 'company-1', {
      ...TX,
      transaction_voucher_links: [{ journal_entry_id: 'je-split', role: null }],
    })
    expect(verdict).toMatchObject({ ok: false, journalEntryId: 'je-split', via: 'link' })
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
  })

  it('fails closed when a read fails', async () => {
    const linksDown = createQueuedMockSupabase()
    linksDown.enqueue({ error: { message: 'timeout' } })
    expect(await assertTransactionBookable(linksDown.supabase as never, 'company-1', TX)).toMatchObject({
      ok: false,
      journalEntryId: null,
      via: 'read_error',
    })

    const entriesDown = createQueuedMockSupabase()
    entriesDown.enqueue({ data: [{ journal_entry_id: 'je-1', role: 'bank_line' }] })
    entriesDown.enqueue({ error: { message: 'timeout' } })
    expect(await assertTransactionBookable(entriesDown.supabase as never, 'company-1', TX)).toMatchObject({
      ok: false,
      via: 'read_error',
    })
  })
})
