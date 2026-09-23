import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { counterpartyKeys, findMatch, observeObligations } from '../observe'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

const tx = (over: Partial<{ id: string; date: string; amount: number; currency: string | null; description: string | null; original_description: string | null; merchant_name: string | null }>) => ({
  id: 'tx-1',
  date: '2026-09-01',
  amount: -12500,
  currency: 'SEK',
  description: 'Fastighets AB Kvarnen',
  original_description: null,
  merchant_name: null,
  ...over,
})
const kvarnen = counterpartyKeys({ id: 'p1', display_name: 'Fastighets AB Kvarnen', legal_name: null, alias_keys: ['fastighets ab kvarnen'] }, 'Kvarnen')
const rent = { due_on: '2026-09-01', amount: 12500, currency: 'SEK' }

beforeEach(() => {
  reset()
})

describe('findMatch', () => {
  it('proves a payment by amount, date and the counterparty in the bank text', () => {
    expect(findMatch(rent, [tx({})], kvarnen)).toEqual({ transaction: tx({}), basis: 'proven' })
    expect(findMatch(rent, [tx({ description: 'Överföring', original_description: 'KVARNEN FASTIGHETS' })], kvarnen)?.basis).toBe('proven')
  })

  it('guesses from a single amount hit without the counterparty, and refuses two', () => {
    expect(findMatch(rent, [tx({ description: 'Överföring 4711' })], kvarnen)).toEqual({ transaction: tx({ description: 'Överföring 4711' }), basis: 'guessed' })
    expect(findMatch(rent, [tx({ description: 'A' }), tx({ id: 'tx-2', description: 'B' })], kvarnen)).toBeNull()
  })

  it('needs the öre, the currency and a date within ten days', () => {
    expect(findMatch(rent, [tx({ amount: -12500.5 })], kvarnen)).toBeNull()
    expect(findMatch(rent, [tx({ currency: 'EUR' })], kvarnen)).toBeNull()
    expect(findMatch(rent, [tx({ date: '2026-09-12' })], kvarnen)).toBeNull()
    expect(findMatch(rent, [tx({ date: '2026-09-11', currency: null })], kvarnen)?.basis).toBe('proven')
  })
})

describe('observeObligations', () => {
  it('marks arrived payments matched, late ones missed, and leaves estimates and fresh ones alone', async () => {
    enqueue({
      data: [
        { id: 'o-late', agreement_id: 'a1', due_on: '2026-08-01', amount: 12500, currency: 'SEK', amount_is_estimate: false, status: 'expected' },
        { id: 'o-paid', agreement_id: 'a1', due_on: '2026-09-01', amount: 12500, currency: 'SEK', amount_is_estimate: false, status: 'expected' },
        { id: 'o-interest', agreement_id: 'a2', due_on: '2026-08-02', amount: 4625, currency: 'SEK', amount_is_estimate: true, status: 'expected' },
        { id: 'o-fresh', agreement_id: 'a1', due_on: '2026-09-14', amount: 12500, currency: 'SEK', amount_is_estimate: false, status: 'expected' },
      ],
    })
    enqueue({ data: [{ id: 'a1', counterparty_party_id: 'p1', counterparty_name: 'Kvarnen' }, { id: 'a2', counterparty_party_id: null, counterparty_name: 'Almi' }] })
    enqueue({ data: [{ id: 'p1', display_name: 'Fastighets AB Kvarnen', legal_name: null, alias_keys: [] }] })
    enqueue({ data: [tx({ id: 'tx-sep', date: '2026-09-01' }), tx({ id: 'tx-interest', date: '2026-08-02', amount: -4625, description: 'Almi' })] })
    enqueue({}) // o-late missed
    enqueue({}) // o-paid matched

    await expect(observeObligations(supabase, 'co-1', '2026-09-15')).resolves.toEqual({ checked: 4, matched: 1, missed: 1 })
    const updates = findCalls('agreement_obligations', 'update').map((args) => args[0])
    expect(updates).toEqual([
      { status: 'missed' },
      expect.objectContaining({ status: 'matched', transaction_id: 'tx-sep', matched_basis: 'proven' }),
    ])
  })

  it('does nothing when no obligation is due', async () => {
    enqueue({ data: [] })
    await expect(observeObligations(supabase, 'co-1', '2026-09-15')).resolves.toEqual({ checked: 0, matched: 0, missed: 0 })
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('surfaces a failed read', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(observeObligations(supabase, 'co-1', '2026-09-15')).rejects.toThrow('obligations fetch failed: boom')
  })
})
