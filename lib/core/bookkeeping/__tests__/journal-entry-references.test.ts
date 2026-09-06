import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  INVOICE_SOURCED_ENTRY_TYPES,
  getInvoiceReferencesForJournalEntries,
  getInvoicesExplainingJournalEntries,
  getJournalEntryUnderlagReferences,
  type ExplainableJournalEntry,
} from '../journal-entry-references'
import { MAX_CHAIN_WALK } from '../correction-chain'

/**
 * The resolver issues its queries in a fixed `.from()` order, and the queued
 * mock consumes one enqueued result per `.from()` call:
 *   1. invoices                  (direct journal_entry_id link)
 *   2. invoice_payments          (payment rows → invoice_id)
 *   3. invoices                  (by id: only when step 2 found new ids)
 *   4. supplier_invoices         (registration_journal_entry_id)
 *   5. supplier_invoices         (payment_journal_entry_id)
 *   6. supplier_invoice_payments (payment rows → supplier_invoice_id)
 *   7. supplier_invoices         (by id: only when step 6 found new ids)
 */
describe('getJournalEntryUnderlagReferences', () => {
  const run = (results: { data: unknown }[]) => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany(results)
    return getJournalEntryUnderlagReferences(
      supabase as unknown as SupabaseClient,
      'company-1',
      'je-1',
    )
  }

  it('surfaces a customer invoice linked only via a cash-method payment row', async () => {
    // The reported gap: debit 1930 / credit 3001, invoice linked through
    // invoice_payments, no document attached and no direct invoice link.
    const refs = await run([
      { data: [] }, // 1. invoices direct: none
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments
      { data: [{ id: 'inv-x', invoice_number: '003' }] }, // 3. invoices by id
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'invoice', id: 'inv-x', number: '003' }])
  })

  it('surfaces a supplier invoice linked via its registration booking', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments (empty → step 3 skipped)
      { data: [{ id: 'si-1', supplier_invoice_number: 'LF-001' }] }, // 4. registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'supplier_invoice', id: 'si-1', number: 'LF-001' }])
  })

  it('surfaces the retained PDF through a supplier payment reference', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: { journal_entry_id: 'je-9' },
      }] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-1' }] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{
      type: 'supplier_invoice',
      id: 'si-1',
      number: 'LF-001',
      document_id: 'doc-1',
    }])
  })

  it('withholds a FLOATING supplier-invoice document but keeps the reference', async () => {
    // An unanchored document (journal_entry_id IS NULL) sits outside the WORM
    // deletion guards, so every missing-underlag surface refuses to count it.
    // Handing it out here is what made the verifikat view show an underlag
    // while the list warned "Underlag saknas" on the same row.
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: { journal_entry_id: null },
      }] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-1' }] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'supplier_invoice', id: 'si-1', number: 'LF-001' }])
  })

  it('accepts the embedded document row in PostgREST array form', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: [{ journal_entry_id: 'je-9' }],
      }] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{
      type: 'supplier_invoice',
      id: 'si-1',
      number: 'LF-001',
      document_id: 'doc-1',
    }])
  })

  it('returns nothing when no invoice is linked (warning legitimately stays)', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([])
  })

  it('deduplicates an invoice reachable via both the direct link and a payment row', async () => {
    const refs = await run([
      { data: [{ id: 'inv-x', invoice_number: '003' }] }, // 1. invoices direct
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments (already known → step 3 skipped)
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'invoice', id: 'inv-x', number: '003' }])
  })

  it('returns both a customer and a supplier invoice, customer first', async () => {
    const refs = await run([
      { data: [{ id: 'inv-a', invoice_number: 'A1' }] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments (empty → step 3 skipped)
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-2' }] }, // 6. supplier_invoice_payments
      { data: [{ id: 'si-2', supplier_invoice_number: 'LF-2' }] }, // 7. supplier by id
    ])

    expect(refs).toEqual([
      { type: 'invoice', id: 'inv-a', number: 'A1' },
      { type: 'supplier_invoice', id: 'si-2', number: 'LF-2' },
    ])
  })

  it('asks only for ISSUED customer invoices: a draft or cancelled one is no underlag (#2298)', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [] }, // 1. invoices direct
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments
      { data: [] }, // 3. invoices by id: the cancelled invoice is filtered out server-side
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])
    const refs = await getJournalEntryUnderlagReferences(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      'je-1',
    )
    expect(refs).toEqual([])
    const notCalls = mock.findCalls('invoices', 'not')
    expect(notCalls).toHaveLength(2)
    for (const call of notCalls) expect(call).toEqual(['status', 'in', '("draft","cancelled")'])
  })
})

/**
 * Batch resolver behind every TS mirror of the RPC's customer-invoice arm
 * (#2298). Fixed `.from()` order: invoices (by journal_entry_id), then
 * invoice_payments (by journal_entry_id).
 */
describe('getInvoiceReferencesForJournalEntries', () => {
  const setup = (results: { data: unknown }[]) => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany(results)
    return mock
  }

  it('returns nothing, without a round trip, for an empty id list', async () => {
    const mock = setup([])
    const refs = await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      [],
    )
    expect(refs.size).toBe(0)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('maps the registration link and payment rows onto their entries, deduplicated', async () => {
    const mock = setup([
      { data: [{ id: 'inv-reg', journal_entry_id: 'je-1' }] },
      {
        data: [
          // The reported case: a SIE-imported voucher matched to an invoice.
          { id: 'pay-a', invoice_id: 'inv-imp', journal_entry_id: 'je-2' },
          // Same invoice already reached through the direct link: once.
          { id: 'pay-b', invoice_id: 'inv-reg', journal_entry_id: 'je-1' },
          // One deposit settling two invoices: both are references.
          { id: 'pay-c', invoice_id: 'inv-other', journal_entry_id: 'je-2' },
          // Defensive: a row without an invoice id is not a reference.
          { id: 'pay-d', invoice_id: null, journal_entry_id: 'je-3' },
        ],
      },
    ])
    const refs = await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1', 'je-2', 'je-3'],
    )
    expect(Array.from(refs.entries())).toEqual([
      ['je-1', ['inv-reg']],
      ['je-2', ['inv-imp', 'inv-other']],
    ])
  })

  it('scopes both lookups to the company and the given ids', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1', 'je-2'],
    )
    expect(mock.findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCalls('invoices', 'in')).toContainEqual(['journal_entry_id', ['je-1', 'je-2']])
    expect(mock.findCalls('invoice_payments', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCalls('invoice_payments', 'in')).toContainEqual([
      'journal_entry_id',
      ['je-1', 'je-2'],
    ])
  })

  it('asks only for ISSUED invoices on both links, mirroring the RPC status guard', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1'],
    )
    expect(mock.findCalls('invoices', 'not')).toContainEqual(['status', 'in', '("draft","cancelled")'])
    // The payment query carries the invoice status as an inner embed and
    // filters on it, so a non-issued invoice's payment row never comes back.
    expect(mock.findCall('invoice_payments', 'select')).toEqual([
      'id, invoice_id, journal_entry_id, invoices!inner(status)',
    ])
    expect(mock.findCalls('invoice_payments', 'not')).toContainEqual([
      'invoices.status',
      'in',
      '("draft","cancelled")',
    ])
  })
})

/**
 * Every link through which a register invoice explains an entry (#2351).
 * Fixed `.from()` order per hop: invoices (by journal_entry_id) and
 * invoice_payments for the entries the engine's own source_id did not settle,
 * then journal_entries (by id) for the parents of unresolved stornos and
 * corrections that are not in the batch.
 */
describe('getInvoicesExplainingJournalEntries', () => {
  const setup = (results: { data: unknown }[]) => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany(results)
    return mock
  }
  const run = (mock: ReturnType<typeof setup>, entries: ExplainableJournalEntry[]) =>
    getInvoicesExplainingJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      entries,
    )
  const engine = (id: string, sourceId: string): ExplainableJournalEntry =>
    ({ id, source_type: 'invoice_created', source_id: sourceId })
  const storno = (id: string, reversesId: string, sourceId: string | null = null): ExplainableJournalEntry =>
    ({ id, source_type: 'storno', source_id: sourceId, reverses_id: reversesId })
  const correction = (id: string, correctionOfId: string): ExplainableJournalEntry =>
    ({ id, source_type: 'correction', source_id: null, correction_of_id: correctionOfId })
  const other = (id: string, sourceType = 'import', sourceId: string | null = null): ExplainableJournalEntry =>
    ({ id, source_type: sourceType, source_id: sourceId })
  const parentFetches = (mock: ReturnType<typeof setup>) => mock.findCalls('journal_entries', 'in')

  it('pins the engine source types whose source_id is a register invoice', () => {
    // rot_rut_payout carries the ROT/RUT request id, never an invoice.
    expect([...INVOICE_SOURCED_ENTRY_TYPES].sort()).toEqual([
      'credit_note',
      'invoice_cash_payment',
      'invoice_created',
      'invoice_paid',
      'reminder_fee',
    ])
  })

  it('returns nothing, without a round trip, for an empty list', async () => {
    const mock = setup([])
    expect((await run(mock, [])).size).toBe(0)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('attributes an engine entry by its source_id with no round trip, even when that invoice is gone', async () => {
    // A missing invoice is a data defect for the caller to report
    // (CUSTOMER_NOT_FOUND in the PS), never a reason to fall silent.
    const mock = setup([])
    const refs = await run(mock, [engine('je-1', 'inv-gone')])
    expect(Array.from(refs.entries())).toEqual([['je-1', ['inv-gone']]])
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('resolves a non-engine entry through the invoice-side links', async () => {
    const mock = setup([
      { data: [] },
      { data: [{ id: 'pay-1', invoice_id: 'inv-x', journal_entry_id: 'je-imp' }] },
    ])
    const refs = await run(mock, [other('je-imp')])
    expect(Array.from(refs.entries())).toEqual([['je-imp', ['inv-x']]])
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('a storno in the same batch as its engine original inherits the invoice without a fetch (#2351)', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    const refs = await run(mock, [engine('je-o', 'inv-1'), storno('je-s', 'je-o')])
    expect(refs.get('je-o')).toEqual(['inv-1'])
    expect(refs.get('je-s')).toEqual(['inv-1'])
    expect(parentFetches(mock)).toEqual([])
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('follows reverses_id, never the copied source_id: a storno of a bank booking resolves to nothing', async () => {
    // reverseEntry() copies the original's source_id verbatim; on a bank
    // booking that is a transaction id, which no reader may take for an
    // invoice. The link column says what the storno cancels.
    const mock = setup([{ data: [] }, { data: [] }])
    const refs = await run(mock, [
      other('je-b', 'bank_transaction', 'tx-1'),
      storno('je-s', 'je-b', 'tx-1'),
    ])
    expect(refs.size).toBe(0)
    expect(parentFetches(mock)).toEqual([])
  })

  it('fetches an original outside the batch by id, company scoped, and both its storno and its correction inherit', async () => {
    // The storno of a May invoice booked in June: the PS for June only holds
    // the storno and the correction, so the original is loaded by id, once.
    const mock = setup([
      { data: [] },
      { data: [] },
      { data: [engine('je-o', 'inv-1')] },
    ])
    const refs = await run(mock, [storno('je-s', 'je-o'), correction('je-c', 'je-o')])
    expect(refs.get('je-s')).toEqual(['inv-1'])
    expect(refs.get('je-c')).toEqual(['inv-1'])
    expect(parentFetches(mock)).toEqual([['id', ['je-o']]])
    expect(mock.findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCall('journal_entries', 'select')).toEqual([
      'id, source_type, source_id, reverses_id, correction_of_id',
    ])
  })

  it('a storno of a linked import inherits every invoice the payment rows name', async () => {
    // The link lives on the original (invoice_payments.journal_entry_id);
    // the storno gets the whole list, so a mixed-customer settlement stays
    // mixed when it is reversed.
    const mock = setup([
      { data: [] },
      { data: [
        { id: 'pay-1', invoice_id: 'inv-a', journal_entry_id: 'je-imp' },
        { id: 'pay-2', invoice_id: 'inv-b', journal_entry_id: 'je-imp' },
      ] },
    ])
    const refs = await run(mock, [other('je-imp'), storno('je-s', 'je-imp')])
    expect(refs.get('je-s')).toEqual(['inv-a', 'inv-b'])
    expect(parentFetches(mock)).toEqual([])
  })

  it('an explicit link on the correction itself wins over the inherited one', async () => {
    const mock = setup([
      { data: [{ id: 'inv-new', journal_entry_id: 'je-c' }] },
      { data: [] },
    ])
    const refs = await run(mock, [correction('je-c', 'je-o')])
    expect(Array.from(refs.entries())).toEqual([['je-c', ['inv-new']]])
    expect(parentFetches(mock)).toEqual([])
  })

  it('walks a chain of corrections up to its root, one fetch per generation', async () => {
    const mock = setup([
      { data: [] },
      { data: [] },
      { data: [correction('je-c1', 'je-o')] },
      { data: [] },
      { data: [] },
      { data: [engine('je-o', 'inv-1')] },
    ])
    const refs = await run(mock, [correction('je-c2', 'je-c1')])
    expect(refs.get('je-c2')).toEqual(['inv-1'])
    expect(parentFetches(mock)).toEqual([
      ['id', ['je-c1']],
      ['id', ['je-o']],
    ])
  })

  it('mirror: a storno whose original no invoice explains resolves to nothing, without a fetch', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    const refs = await run(mock, [other('je-m', 'manual'), storno('je-s', 'je-m')])
    expect(refs.size).toBe(0)
    expect(parentFetches(mock)).toEqual([])
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('a cycle terminates without a fetch', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    const refs = await run(mock, [storno('a', 'b'), storno('b', 'a')])
    expect(refs.size).toBe(0)
    expect(parentFetches(mock)).toEqual([])
  })

  it('bounds an in-batch chain at MAX_CHAIN_WALK links, in either batch order (PR #2354 review)', async () => {
    // je-0 is the engine root and je-k the storno of je-(k-1): eleven links
    // in one batch. The ten within the cap inherit, the eleventh does not,
    // the same answer the fetched walk gives a chain of that length. Both
    // orders: ascending resolves each child off an already attributed
    // parent, descending queues them all and propagates from the root.
    const chain = [engine('je-0', 'inv-1')]
    for (let k = 1; k <= MAX_CHAIN_WALK + 1; k++) chain.push(storno(`je-${k}`, `je-${k - 1}`))
    for (const batch of [chain, [...chain].reverse()]) {
      const mock = setup([{ data: [] }, { data: [] }])
      const refs = await run(mock, batch)
      for (let k = 0; k <= MAX_CHAIN_WALK; k++) expect(refs.get(`je-${k}`), `je-${k}`).toEqual(['inv-1'])
      expect(refs.has(`je-${MAX_CHAIN_WALK + 1}`)).toBe(false)
      expect(parentFetches(mock)).toEqual([])
    }
  })

  it('stops a chain that never reaches a root at MAX_CHAIN_WALK generations', async () => {
    const mock = createQueuedMockSupabase()
    for (let k = 0; k <= MAX_CHAIN_WALK; k++) {
      mock.enqueueMany([
        { data: [] },
        { data: [] },
        { data: [storno(`p${k + 1}`, `p${k + 2}`)] },
      ])
    }
    const refs = await run(mock, [storno('je-s', 'p1')])
    expect(refs.size).toBe(0)
    expect(parentFetches(mock)).toHaveLength(MAX_CHAIN_WALK)
  })
})
