import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  isTransactionBooked,
  getPrimaryJournalEntryId,
  getLinkedJournalEntryIds,
  embeddedVoucherLabel,
  assertTransactionBookable,
  decideBankRowRebooking,
  decideBankRowRebookingById,
  bankRowRefusalCode,
  type BankRowRefusal,
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
    expect(embeddedVoucherLabel({ journal_entry_id: 'x', journal_entry: { voucher_series: null, voucher_number: 7 } })).toBe('A7')
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
    expect(await decideBankRowRebooking(supabase as never, 'company-1', BOOKED, { replace: false })).toEqual({ outcome: 'open' })
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

  it.each(['pointer', 'link', 'reconciliation'] as const)('answers the door\'s own code for a row booked by %s', (via) => {
    expect(bankRowRefusalCode(refusal(via), 'DOOR_ALREADY_BOOKED')).toBe('DOOR_ALREADY_BOOKED')
  })

  it('answers one code for an ignored row on every door', () => {
    expect(bankRowRefusalCode(refusal('ignored'), 'DOOR_ALREADY_BOOKED')).toBe('BANK_ROW_IGNORED')
  })

  it('never calls a failed read booked: the row may be free, and the answer is a retry', () => {
    expect(bankRowRefusalCode(refusal('read_error'), 'DOOR_ALREADY_BOOKED')).toBe('BANK_ROW_READ_FAILED')
  })
})
