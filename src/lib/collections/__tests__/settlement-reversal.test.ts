import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'
import { releaseSettlementAfterReversal, SETTLEMENT_VOUCHER_REVERSED } from '../settlement-reversal'

const COMPANY = 'company-1'

let mem: MemorySupabase

beforeEach(() => {
  mem = createMemorySupabase()
  mem.seed('collection_settlements', [
    {
      id: 'stl-1',
      company_id: COMPANY,
      status: 'booked',
      journal_entry_id: 'je-d1',
      booked_at: '2026-10-02T08:00:00.000Z',
      booked_by: 'user-1',
      document_attachment_id: 'doc-1',
      provider_acknowledged_at: '2026-10-02T08:00:01.000Z',
      needs_mapping_reason: null,
      bank_transaction_id: 'tx-payout',
    },
    { id: 'stl-2', company_id: COMPANY, status: 'booked', journal_entry_id: 'je-d2', booked_at: '2026-10-03T08:00:00.000Z' },
  ])
  mem.seed('collection_settlement_lines', [
    { id: 'l-1', company_id: COMPANY, settlement_id: 'stl-1', position: 0, booked: true },
    { id: 'l-2', company_id: COMPANY, settlement_id: 'stl-2', position: 0, booked: true },
  ])
  mem.seed('collection_collected_payments', [
    { id: 'c-1', company_id: COMPANY, settlement_id: 'stl-1', status: 'booked' },
    { id: 'c-2', company_id: COMPANY, settlement_id: 'stl-2', status: 'booked' },
  ])
})

describe('releaseSettlementAfterReversal', () => {
  it('returns the payout of a reversed voucher to a person, untied from its collected payments', async () => {
    expect(await releaseSettlementAfterReversal(COMPANY, 'je-d1', { db: mem.client as SupabaseClient })).toEqual({ released: true })

    expect(mem.rows('collection_settlements').find((r) => r.id === 'stl-1')).toMatchObject({
      status: 'needs_mapping',
      needs_mapping_reason: SETTLEMENT_VOUCHER_REVERSED,
      journal_entry_id: null,
      booked_at: null,
      booked_by: null,
      // The PDF stays the underlag of the reversed voucher; the next booking archives a copy.
      document_attachment_id: null,
      provider_acknowledged_at: null,
      // The storno released the bank row; the next booking links it again.
      bank_transaction_id: null,
    })
    expect(mem.rows('collection_settlement_lines').find((r) => r.id === 'l-1')).toMatchObject({ booked: false })
    expect(mem.rows('collection_collected_payments').find((r) => r.id === 'c-1')).toMatchObject({ settlement_id: null, status: 'booked' })

    // Another payout is left alone.
    expect(mem.rows('collection_settlements').find((r) => r.id === 'stl-2')).toMatchObject({ status: 'booked', journal_entry_id: 'je-d2' })
    expect(mem.rows('collection_settlement_lines').find((r) => r.id === 'l-2')).toMatchObject({ booked: true })
    expect(mem.rows('collection_collected_payments').find((r) => r.id === 'c-2')).toMatchObject({ settlement_id: 'stl-2' })
  })

  it('does nothing for a voucher that is no payout, or another company\'s', async () => {
    expect(await releaseSettlementAfterReversal(COMPANY, 'je-other', { db: mem.client as SupabaseClient })).toEqual({ released: false })
    expect(await releaseSettlementAfterReversal('company-2', 'je-d1', { db: mem.client as SupabaseClient })).toEqual({ released: false })
    expect(mem.writes).toEqual([])
  })

  it('never throws into the reversal that already happened', async () => {
    mem.failures.set('collection_collected_payments:update', { message: 'connection reset' })
    expect(await releaseSettlementAfterReversal(COMPANY, 'je-d1', { db: mem.client as SupabaseClient })).toEqual({ released: false })
    expect(mem.rows('collection_settlements').find((r) => r.id === 'stl-1')).toMatchObject({ status: 'booked', journal_entry_id: 'je-d1' })
  })
})
