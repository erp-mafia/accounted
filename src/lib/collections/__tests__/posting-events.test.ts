/**
 * The collections doors on the posting port (lib/posting): the payout's
 * business event, and the rebook's storno, which goes through the port with
 * reverseEntry's own collectionsRebook option.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const port = vi.hoisted(() => ({
  reverseJournalEntry: vi.fn(async () => ({ id: 'je-storno' })),
}))
vi.mock('@/lib/posting/port', () => ({ postingPort: port }))

import { collectionSettlementBusinessEvent } from '../settlements'
import { rebookCollectedPayment } from '../rebook'
import { createMemorySupabase } from './memory-supabase'

describe('collectionSettlementBusinessEvent', () => {
  it('records the payout as sale.payout_settled: SEK in on the payment date, with its document and rule source', () => {
    const event = collectionSettlementBusinessEvent({ payment_date: '2026-10-14', amount: 1234.5 }, '00000000-0000-4000-8000-000000000d01')
    expect(event).toMatchObject({
      kind: 'sale.payout_settled',
      category: null,
      occurredOn: '2026-10-14',
      currency: 'SEK',
      amount: 1234.5,
      amountSek: 1234.5,
      taxAmounts: [],
      evidence: { direction: 'in', document_id: '00000000-0000-4000-8000-000000000d01' },
      jurisdiction: 'SE',
    })
    expect(event.mappingVersion).toMatch(/^se\.collections-settlement-lines@/)
    expect(event.subject).toBeUndefined()
    expect(event.party).toBeUndefined()
  })

  it('names no document while the payout has none', () => {
    expect(collectionSettlementBusinessEvent({ payment_date: '2026-10-14', amount: 10 }, null).evidence).toEqual({
      direction: 'in',
      document_id: undefined,
    })
  })
})

describe('rebookCollectedPayment: the storno through the posting port', () => {
  beforeEach(() => {
    port.reverseJournalEntry.mockClear()
  })

  it('reverses the C voucher with collectionsRebook and a storno event when no reverse is injected', async () => {
    const mem = createMemorySupabase()
    mem.seed('collection_connections', [
      { id: 'connection-1', company_id: 'company-1', route: 'fake', state: 'active', user_id: 'user-1', consented_by: 'user-1', clearing_account: '1689', payout_account: '1930', display_name: 'Acme Inkasso' },
    ])
    mem.seed('collection_cases', [{ id: 'case-1', company_id: 'company-1', invoice_id: 'invoice-1', connection_id: 'connection-1', opened_by: 'user-1' }])
    mem.seed('journal_entries', [{ id: 'je-c1', company_id: 'company-1', status: 'posted', reversed_by_id: null }])
    mem.seed('collection_collected_payments', [
      {
        id: 'collected-1',
        company_id: 'company-1',
        case_id: 'case-1',
        invoice_id: 'invoice-1',
        provider_payment_ref: 'pay-1',
        paid_at: '2026-09-27',
        total: 1100,
        capital_paid: 1000,
        to_creditor_other: 0,
        to_agency: 100,
        status: 'booked',
        invoice_payment_id: 'ip-1',
        journal_entry_id: 'je-c1',
        payment_record_document_id: 'record-old',
        booked_at: '2026-09-28T10:00:00.000Z',
        booked_by: 'user-1',
        review_reason: null,
        booking_lease_until: null,
        settlement_id: null,
        rebooked_entry_ids: [],
      },
    ])
    // The release fails, so the run stops right after the storno this test is about.
    mem.rpcs.set('collections_rebook_release', () => {
      throw new Error('stop here')
    })

    await expect(
      rebookCollectedPayment(
        { db: mem.client as SupabaseClient, companyId: 'company-1', now: () => new Date('2026-10-07T09:00:00.000Z') },
        'collected-1',
        { userId: 'user-1' },
      ),
    ).rejects.toThrow()

    expect(port.reverseJournalEntry).toHaveBeenCalledTimes(1)
    const request = (port.reverseJournalEntry.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(request).toMatchObject({
      companyId: 'company-1',
      userId: 'user-1',
      entryId: 'je-c1',
      reversalDate: undefined,
      options: { collectionsRebook: true },
      role: 'reversal',
    })
    const event = (request.event as () => Record<string, unknown>)()
    expect(event).toMatchObject({ kind: 'ledger.storno', subject: { type: 'journal_entry', id: 'je-c1' } })
  })
})
