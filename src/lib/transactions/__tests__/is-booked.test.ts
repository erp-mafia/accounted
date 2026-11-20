import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  getPrimaryJournalEntryId,
  getLinkedJournalEntryIds,
  embeddedVoucherLabel,
  assertTransactionBookable,
  decideBankRowRebooking,
  decideBankRowRebookingById,
  bankRowRefusalCode,
  readNamedBankRows,
  type BankRowRefusal,
} from '../is-booked'

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
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: null, voucher_number: 7 } })).toBe('A7')
    expect(embeddedVoucherLabel({ journal_entry_id: 'x' })).toBeNull()
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: 'A', voucher_number: null } })).toBeNull()
  })
})

describe('assertTransactionBookable', () => {
  const TX = { id: 'tx-1', journal_entry_id: null as string | null }

  it('lets an unanchored row through after the links read and the booked-from read', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // transaction_voucher_links
    enqueue({ data: [] }) // posted verifikat booked from the row: none
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
    expect(findCalls('transaction_voucher_links', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['transaction_id', 'tx-1'],
    ])
    // Nothing anchors it, so the posted verifikat booked from it are asked, on
    // their own index (journal_entries_posted_bank_source_idx).
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['source_type', 'bank_transaction'],
    ])
    expect(findCalls('journal_entries', 'in')).toEqual([['source_id', ['tx-1']], ['status', ['posted', 'reversed']]])
  })

  // #203: the claim after the posting never landed (the busy bank-account
  // lock refused it and the compensating storno alike), so the verifikat
  // stood beside a row its pointer and links read as open, and the row was
  // booked a second time 21 s to 11 min later.
  it('refuses a row no anchor names that a posted verifikat was booked from, naming it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // transaction_voucher_links
    enqueue({
      data: [
        { id: 'je-second', status: 'posted', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 40 },
        { id: 'je-first', status: 'posted', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 31 },
      ],
    })
    // The lowest voucher number first: the verifikat that booked the row first.
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({
      ok: false,
      code: 'TRANSACTION_ALREADY_CATEGORIZED',
      journalEntryId: 'je-first',
      via: 'named',
      voucher: 'A31',
    })
  })

  it('matches the row however the door spelled its id', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-first', status: 'posted', source_type: 'bank_transaction', source_id: 'aa11bb22-0000-4000-8000-000000000001', voucher_series: 'A', voucher_number: 31 }] })
    const verdict = await assertTransactionBookable(supabase as never, 'company-1', { id: 'AA11BB22-0000-4000-8000-000000000001', journal_entry_id: null })
    expect(verdict).toMatchObject({ ok: false, via: 'named', journalEntryId: 'je-first' })
    expect(findCalls('journal_entries', 'in')).toEqual([['source_id', ['AA11BB22-0000-4000-8000-000000000001']], ['status', ['posted', 'reversed']]])
  })

  it('asks nothing more about a row its pointer or a link already books', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-1', status: 'posted' }] })
    await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-1' })
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-1']]])
  })

  it('lets a row through after a storno of what booked it: only posted verifikat booked from the row count', async () => {
    // The read asks for status 'posted' and source_type 'bank_transaction': the
    // reversed original and its storno ('storno') are neither
    // (tests/pg/named-bank-row-gate.pg.test.ts runs it on real Postgres).
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    enqueue({ data: null }) // standing_correction: none stands
    enqueue({ data: [] }) // posted verifikat booked from the row: none
    expect(await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-old' }))
      .toEqual({ ok: true })
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-old']], ['source_id', ['tx-1']], ['status', ['posted', 'reversed']]])
  })

  it('opens a row whose booked-from verifikat was reversed by a storno: nothing books its money on', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({
      data: [
        { id: 'je-old', status: 'reversed', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 3 },
        // Not booked from the row, whatever an answer carries: a storno is 'storno'.
        { id: 'je-storno', status: 'posted', source_type: 'storno', source_id: 'tx-1', voucher_series: 'A', voucher_number: 4 },
      ],
    })
    enqueue({ data: null }) // standing_correction of je-old: a storno is no correction
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
    expect(supabase.rpc).toHaveBeenCalledWith('standing_correction', { p_entry_id: 'je-old' })
    expect(findCalls('journal_entries', 'in')).toEqual([['source_id', ['tx-1']], ['status', ['posted', 'reversed']]])
  })

  it('refuses a row whose booked-from verifikat was corrected, naming the correction that books its money', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-first', status: 'reversed', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 31 }] })
    enqueue({ data: 'je-corr' }) // standing_correction: the rättelse books on a bank account
    enqueue({ data: { id: 'je-corr', source_type: 'correction', source_id: null, voucher_series: 'A', voucher_number: 40 } })
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({
      ok: false,
      code: 'TRANSACTION_ALREADY_CATEGORIZED',
      journalEntryId: 'je-corr',
      via: 'named',
      voucher: 'A40',
    })
  })

  it('asks no second time about a stale pointer readPostedAnchors already asked about', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    enqueue({ data: null }) // standing_correction of the pointer: none
    enqueue({ data: [{ id: 'je-old', status: 'reversed', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 3 }] })
    expect(await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-old' })).toEqual({ ok: true })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the booked-from read fails or answers no list', async () => {
    for (const answer of [{ error: { message: 'timeout' } }, { data: { id: 'je-1' } }]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [] })
      enqueue(answer)
      expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({
        ok: false,
        code: 'TRANSACTION_ALREADY_CATEGORIZED',
        journalEntryId: null,
        via: 'read_error',
      })
    }
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
    enqueue({ data: null }) // standing_correction: none stands
    expect(
      await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-old' }),
    ).toEqual({ ok: true })
    expect(supabase.rpc).toHaveBeenCalledWith('standing_correction', { p_entry_id: 'je-old' })
  })

  it('refuses a row whose pointer names a verifikat a standing correction replaced, as a link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // transaction_voucher_links
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    enqueue({ data: 'je-correction' }) // standing_correction
    enqueue({ data: { id: 'je-correction', source_type: 'correction', source_id: null, voucher_series: 'A', voucher_number: 13 } })
    expect(
      await assertTransactionBookable(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-old' }),
    ).toEqual({ ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', journalEntryId: 'je-correction', via: 'link' })
  })

  it('asks for no correction while every anchor names a posted verifikat', async () => {
    const posted = createQueuedMockSupabase()
    posted.enqueue({ data: [{ journal_entry_id: 'je-2', role: 'bank_line' }] })
    posted.enqueue({ data: [{ id: 'je-1', status: 'posted' }, { id: 'je-2', status: 'posted' }] })
    await assertTransactionBookable(posted.supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: 'je-1' })
    expect(posted.supabase.rpc).not.toHaveBeenCalled()
  })

  it('a link at a reversed verifikat counts while a correction of it stands, as a pointer does', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-old', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    enqueue({ data: 'je-new' }) // standing_correction
    enqueue({ data: { id: 'je-new', source_type: 'correction', source_id: null, voucher_series: 'A', voucher_number: 7 } })

    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toMatchObject({
      ok: false,
      via: 'link',
      journalEntryId: 'je-new',
    })
    expect(supabase.rpc).toHaveBeenCalledWith('standing_correction', { p_entry_id: 'je-old' })
  })

  it('a link at a reversed verifikat with no correction books nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-old', role: 'bank_line' }] })
    enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    enqueue({ data: null })

    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
  })

  it('ignores supplementary roles and never reads their verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-residual', role: 'other' }, { journal_entry_id: 'je-c', role: 'clearing' }] })
    enqueue({ data: [] }) // posted verifikat booked from the row: none
    expect(await assertTransactionBookable(supabase as never, 'company-1', TX)).toEqual({ ok: true })
    expect(findCalls('journal_entries', 'in')).toEqual([['source_id', ['tx-1']], ['status', ['posted', 'reversed']]])
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

    const stale = { id: 'tx-1', journal_entry_id: 'je-old' }
    const correctionDown = createQueuedMockSupabase()
    correctionDown.enqueue({ data: [] })
    correctionDown.enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    correctionDown.enqueue({ error: { message: 'timeout' } })
    expect(await assertTransactionBookable(correctionDown.supabase as never, 'company-1', stale)).toMatchObject({
      ok: false,
      via: 'read_error',
    })

    const correctionRowDown = createQueuedMockSupabase()
    correctionRowDown.enqueue({ data: [] })
    correctionRowDown.enqueue({ data: [{ id: 'je-old', status: 'reversed' }] })
    correctionRowDown.enqueue({ data: 'je-correction' })
    correctionRowDown.enqueue({ error: { message: 'timeout' } })
    expect(await assertTransactionBookable(correctionRowDown.supabase as never, 'company-1', stale)).toMatchObject({
      ok: false,
      via: 'read_error',
    })
  })
})

describe('decideBankRowRebooking', () => {
  // A row's own categorization: booked from this row by the categorize door.
  const OWN = { id: 'je-own', status: 'posted', source_type: 'bank_transaction', source_id: 'tx-1', voucher_series: 'A', voucher_number: 12 }
  const BOOKED = { id: 'tx-1', journal_entry_id: 'je-own', reconciliation_method: null }

  it('lets an unbooked row through', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: null }, { replace: false }))
      .toEqual({ outcome: 'open' })
  })

  it("refuses the row's own categorization unless asked, and says it may be reversed", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [OWN] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: false })).toEqual({
      outcome: 'refuse',
      via: 'pointer',
      journalEntryId: 'je-own',
      voucher: 'A12',
      replaceable: true,
      undo: 'uncategorize',
    })
  })

  it("replaces the row's own categorization when asked", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [OWN] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true })).toEqual({
      outcome: 'replace',
      journalEntryId: 'je-own',
    })
  })

  it('replaces a bulk-book N=1 booking (pointer and link name the same own verifikat) as one booking', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-own', role: 'bank_line' }] })
    enqueue({ data: [OWN] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true }))
      .toMatchObject({ outcome: 'replace', journalEntryId: 'je-own' })
  })

  it('never replaces a reconciliation link, even when asked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ ...OWN, id: 'je-sie', source_type: 'import', source_id: null, voucher_number: 7 }] })
    expect(
      await decideBankRowRebooking(
        supabase as never,
        'company-1',
        { id: 'tx-1', journal_entry_id: 'je-sie', reconciliation_method: 'manual' },
        { replace: true },
      ),
    ).toEqual({ outcome: 'refuse', via: 'reconciliation', journalEntryId: 'je-sie', voucher: 'A7', replaceable: false, undo: 'unlink' })
  })

  it('never replaces a link-only row (a samlingsverifikat with N>1), even when asked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-samling', role: 'bank_line' }] })
    enqueue({ data: [{ ...OWN, id: 'je-samling', source_type: 'manual', source_id: null, voucher_number: 40 }] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: null }, { replace: true }))
      .toEqual({ outcome: 'refuse', via: 'link', journalEntryId: 'je-samling', voucher: 'A40', replaceable: false, undo: 'reverse_voucher' })
  })

  it('never replaces a pointer booked from another source (a customer payment, an utlägg payout)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ ...OWN, source_type: 'supplier_invoice_paid', source_id: 'si-1' }] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true }))
      .toMatchObject({ outcome: 'refuse', via: 'pointer', replaceable: false })
  })

  it("never replaces the row's own verifikat while a link names another posted one (a 1:N split)", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ journal_entry_id: 'je-own', role: 'bank_line' }, { journal_entry_id: 'je-other', role: 'bank_line' }] })
    enqueue({ data: [OWN, { ...OWN, id: 'je-other', source_type: 'manual', source_id: null, voucher_number: 13 }] })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true }))
      .toMatchObject({ outcome: 'refuse', via: 'pointer', journalEntryId: 'je-own', replaceable: false })
  })

  it('refuses an ignored row before it reads anything: the row can carry no verifikat', async () => {
    const { supabase } = createQueuedMockSupabase()

    expect(
      await decideBankRowRebooking(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: null, is_ignored: true }, { replace: true }),
    ).toEqual({ outcome: 'refuse', via: 'ignored', journalEntryId: null, voucher: null, replaceable: false, undo: 'restore' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('says how each refused shape opens again: only the pointer of a booking is undone by uncategorize', async () => {
    const decide = async (row: { journal_entry_id: string | null; reconciliation_method: string | null }, links: unknown[], entries: unknown[]) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: links })
      enqueue({ data: entries })
      const decision = await decideBankRowRebooking(supabase as never, 'company-1', { id: 'tx-1', ...row }, { replace: false })
      return decision.outcome === 'refuse' ? [decision.via, decision.undo] : decision.outcome
    }
    const FOREIGN = { ...OWN, source_type: 'manual', source_id: null }
    const LINK = { journal_entry_id: 'je-own', role: 'bank_line' }

    expect(await decide({ journal_entry_id: 'je-own', reconciliation_method: null }, [], [OWN])).toEqual(['pointer', 'uncategorize'])
    expect(await decide({ journal_entry_id: 'je-own', reconciliation_method: null }, [], [FOREIGN])).toEqual(['pointer', 'uncategorize'])
    // Uncategorize would reverse the independent verifikat: the link comes off instead.
    expect(await decide({ journal_entry_id: 'je-own', reconciliation_method: 'auto_exact' }, [], [FOREIGN])).toEqual(['reconciliation', 'unlink'])
    expect(await decide({ journal_entry_id: null, reconciliation_method: 'manual' }, [LINK], [FOREIGN])).toEqual(['link', 'unlink'])
    // A samlingsverifikat: no pointer to undo, no link to take off (LINK_IS_BOOKING).
    expect(await decide({ journal_entry_id: null, reconciliation_method: null }, [LINK], [FOREIGN])).toEqual(['link', 'reverse_voucher'])
  })

  it('lets a row through whose pointer names a reversed verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ ...OWN, status: 'reversed' }] })
    enqueue({ data: null }) // standing_correction: none stands
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: false })).toEqual({ outcome: 'open' })
  })

  it('refuses a corrected row as a link, even when asked: only a storno of the correction opens it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ ...OWN, status: 'reversed' }] })
    enqueue({ data: 'je-correction' }) // standing_correction
    enqueue({ data: { ...OWN, id: 'je-correction', source_type: 'correction', source_id: null, voucher_number: 13 } })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true })).toEqual({
      outcome: 'refuse',
      via: 'link',
      journalEntryId: 'je-correction',
      voucher: 'A13',
      replaceable: false,
      undo: 'reverse_voucher',
    })
  })

  it('refuses a row only a posted verifikat names, naming it, and opens it by its storno', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ ...OWN, id: 'je-first', voucher_number: 31 }] }) // booked from the row, never claimed
    expect(await decideBankRowRebooking(supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: null }, { replace: true })).toEqual({
      outcome: 'refuse',
      via: 'named',
      journalEntryId: 'je-first',
      voucher: 'A31',
      replaceable: false,
      undo: 'reverse_voucher',
    })
  })

  it("never replaces the row's own categorization while another posted verifikat names the row", async () => {
    // The #203 pairs as they stand: the second booking holds the pointer, the
    // first still names the row. A storno of the pointer's would leave the first.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [OWN] })
    enqueue({ data: [OWN, { ...OWN, id: 'je-first', voucher_number: 31 }] }) // booked from the row: both
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true })).toEqual({
      outcome: 'refuse',
      via: 'named',
      journalEntryId: 'je-first',
      voucher: 'A31',
      replaceable: false,
      undo: 'reverse_voucher',
    })
  })

  it("replaces the row's own categorization when it is the only verifikat that names the row", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [OWN] })
    enqueue({ data: [OWN] }) // booked from the row: the pointer's only
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true }))
      .toEqual({ outcome: 'replace', journalEntryId: 'je-own' })
  })

  it('fails closed when the booked-from read fails', async () => {
    const open = createQueuedMockSupabase()
    open.enqueue({ data: [] })
    open.enqueue({ error: { message: 'timeout' } })
    expect(await decideBankRowRebooking(open.supabase as never, 'company-1', { id: 'tx-1', journal_entry_id: null }, { replace: false }))
      .toEqual({ outcome: 'refuse', via: 'read_error', journalEntryId: null, voucher: null, replaceable: false, undo: null })

    const own = createQueuedMockSupabase()
    own.enqueue({ data: [] })
    own.enqueue({ data: [OWN] })
    own.enqueue({ error: { message: 'timeout' } })
    expect(await decideBankRowRebooking(own.supabase as never, 'company-1', BOOKED, { replace: true }))
      .toMatchObject({ outcome: 'refuse', via: 'read_error', replaceable: false })
  })

  it('fails closed on a read error, and never offers a storno then', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'timeout' } })
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: true })).toEqual({
      outcome: 'refuse',
      via: 'read_error',
      journalEntryId: null,
      voucher: null,
      replaceable: false,
      undo: null,
    })
  })
})

describe('decideBankRowRebookingById', () => {
  const ROW = { id: 'tx-1', journal_entry_id: null, reconciliation_method: null, is_ignored: false, transaction_voucher_links: [] }

  it('reads the row with its links and asks the same gate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW, transaction_voucher_links: [{ journal_entry_id: 'je-samling', role: 'bank_line' }] } })
    enqueue({ data: [{ id: 'je-samling', status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 40 }] })
    expect(await decideBankRowRebookingById(supabase as never, 'company-1', 'tx-1', { replace: false }))
      .toEqual({ outcome: 'refuse', via: 'link', journalEntryId: 'je-samling', voucher: 'A40', replaceable: false, undo: 'reverse_voucher' })
  })

  it('refuses an ignored row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW, is_ignored: true } })
    expect(await decideBankRowRebookingById(supabase as never, 'company-1', 'tx-1', { replace: false }))
      .toMatchObject({ outcome: 'refuse', via: 'ignored', undo: 'restore' })
  })

  it("answers open for a row that is not there: the door's own write refuses it", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await decideBankRowRebookingById(supabase as never, 'company-1', 'tx-1', { replace: false })).toEqual({ outcome: 'open' })
  })

  it('fails closed when the row cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'timeout' } })
    expect(await decideBankRowRebookingById(supabase as never, 'company-1', 'tx-1', { replace: false }))
      .toEqual({ outcome: 'refuse', via: 'read_error', journalEntryId: null, voucher: null, replaceable: false, undo: null })
  })
})

describe('bankRowRefusalCode', () => {
  const refusal = (via: BankRowRefusal['via']): BankRowRefusal => ({
    outcome: 'refuse',
    via,
    journalEntryId: null,
    voucher: null,
    replaceable: false,
    undo: null,
  })

  it.each(['pointer', 'link', 'reconciliation', 'named'] as const)('answers the door\'s own code for a row booked by %s', (via) => {
    expect(bankRowRefusalCode(refusal(via), 'DOOR_ALREADY_BOOKED')).toBe('DOOR_ALREADY_BOOKED')
  })

  it('answers one code for an ignored row on every door', () => {
    expect(bankRowRefusalCode(refusal('ignored'), 'DOOR_ALREADY_BOOKED')).toBe('BANK_ROW_IGNORED')
  })

  it('never calls a failed read booked: the row may be free, and the answer is a retry', () => {
    expect(bankRowRefusalCode(refusal('read_error'), 'DOOR_ALREADY_BOOKED')).toBe('BANK_ROW_READ_FAILED')
  })
})

describe('readNamedBankRows', () => {
  it('names the first posted verifikat booked from each row, in one read, and leaves the rest out', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'je-a2', status: 'posted', source_type: 'bank_transaction', source_id: 'tx-a', voucher_series: 'A', voucher_number: 9 },
        { id: 'je-a', status: 'posted', source_type: 'bank_transaction', source_id: 'tx-a', voucher_series: 'A', voucher_number: 5 },
      ],
    })
    const named = await readNamedBankRows(supabase as never, 'company-1', ['tx-a', 'tx-b', 'tx-a'])
    expect(named).toEqual(new Map([['tx-a', { journalEntryId: 'je-a', voucher: 'A5' }]]))
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(findCalls('journal_entries', 'in')).toEqual([['source_id', ['tx-a', 'tx-b']], ['status', ['posted', 'reversed']]])
  })

  it('reads nothing for no rows, and fails closed when the read fails', async () => {
    const none = createQueuedMockSupabase()
    expect(await readNamedBankRows(none.supabase as never, 'company-1', [])).toEqual(new Map())
    expect(none.supabase.from).not.toHaveBeenCalled()

    const down = createQueuedMockSupabase()
    down.enqueue({ error: { message: 'timeout' } })
    expect(await readNamedBankRows(down.supabase as never, 'company-1', ['tx-a'])).toBe('read_error')
  })
})
