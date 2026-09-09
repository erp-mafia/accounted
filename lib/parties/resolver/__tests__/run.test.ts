import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ledgerKey } from '@/lib/parties/ledger-key'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { candidatesFor, groupStrings, resolveCompanyCounterparts, resolverMode } from '../run'

vi.mock('@/lib/ai', () => ({
  getAiService: () => { throw new Error('not used') },
  getAiStatus: () => ({ configured: false }),
}))

const COMPANY = '11111111-1111-4111-8111-111111111111'

describe('resolverMode', () => {
  it('is act unless switched off', () => {
    delete process.env.COUNTERPARTY_RESOLVER_MODE
    expect(resolverMode()).toBe('act')
    process.env.COUNTERPARTY_RESOLVER_MODE = 'off'
    expect(resolverMode()).toBe('off')
    delete process.env.COUNTERPARTY_RESOLVER_MODE
  })
})

describe('groupStrings', () => {
  it('groups transactions by alias key with counts and the average amount', () => {
    const g = groupStrings([
      { id: 't1', original_description: 'ANTHROPIC* CLAUDE SUB', description: null, amount: -200, currency: 'SEK', merchant_name: null },
      { id: 't2', original_description: 'ANTHROPIC* CLAUDE SUB', description: 'renamed by user', amount: -220, currency: 'SEK', merchant_name: null },
      { id: 't3', original_description: null, description: 'Lön Jakob Juni', amount: -20000, currency: 'SEK', merchant_name: null },
      { id: 't4', original_description: null, description: '', amount: -1, currency: 'SEK', merchant_name: null },
    ])
    expect(g.size).toBe(2)
    const anthropic = [...g.values()].find((x) => x.raw.startsWith('ANTHROPIC'))!
    expect(anthropic.txIds).toEqual(['t1', 't2'])
    expect(anthropic.count).toBe(2)
    expect(anthropic.amountAbs).toBe(420)
  })
})

describe('candidatesFor', () => {
  it('offers register parties that share a token, most overlap first, at most five', () => {
    const parties = [
      { id: 'a', display_name: 'Anthropic', alias_keys: [], status: 'confirmed' },
      { id: 'b', display_name: 'Anthropic Ireland Ltd', alias_keys: [], status: 'suggested' },
      { id: 'c', display_name: 'Dustin Sverige AB', alias_keys: [], status: 'confirmed' },
      { id: 'd', display_name: 'Hotel at Booking.com', alias_keys: [], status: 'suggested' },
      { id: 'e', display_name: 'Utlägg Sabis', alias_keys: [], status: 'suggested' },
    ]
    const c = candidatesFor('Anthropic, PBC', parties)
    expect(c.map((x) => x.partyId)).toEqual(['a', 'b'])
    expect(candidatesFor('100004087691', parties)).toEqual([])
    // A shared generic word is not a resemblance.
    expect(candidatesFor('HOTEL HANSSON', parties)).toEqual([])
    expect(candidatesFor('Utlägg Nam', parties)).toEqual([])
  })
})

describe('resolveCompanyCounterparts', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
    mock.reset()
  })

  it('writes one alias per new string from the anchors and the directory without a model', async () => {
    // transactions page
    mock.enqueue({
      data: [
        { id: 't1', original_description: 'Kortköp 260828 KRONANS APOTEK AB', description: null, amount: -475, currency: 'SEK', merchant_name: null },
        { id: 't2', original_description: 'SQSP  WORKSP', description: null, amount: -92, currency: 'SEK', merchant_name: null },
        { id: 't3', original_description: 'Lön Jakob Juni Överföring via internet', description: null, amount: -20654, currency: 'SEK', merchant_name: null },
        { id: 't4', original_description: 'ALREADY DONE AB', description: null, amount: -10, currency: 'SEK', merchant_name: null },
      ],
    })
    // live aliases: the fourth string is already resolved
    mock.enqueue({ data: [{ alias_key: 'already done' }] })
    // document hits: none
    mock.enqueue({ data: [] })
    // register parties, then the register's giro numbers
    mock.enqueue({ data: [{ id: 'p-sq', display_name: 'Squarespace', alias_keys: [], status: 'confirmed' }] })
    mock.enqueue({ data: [] })
    // directory table lookups for the strings the seed does not know (the salary line only)
    mock.enqueue({ data: [] })
    // insert
    mock.enqueue({ data: null })

    const summary = await resolveCompanyCounterparts(mock.supabase as unknown as SupabaseClient, COMPANY, { useModel: false })
    expect(summary.strings).toBe(4)
    expect(summary.alreadyResolved).toBe(1)
    expect(summary.planned).toBe(3)
    expect(summary.written).toBe(3)
    expect(summary.byBand).toEqual({ link: 2, tentative: 0, nil: 1 })
    expect(summary.modelLines).toBe(0)

    const inserted = mock.findCall('counterparty_aliases', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(inserted).toHaveLength(3)
    const byName = Object.fromEntries(inserted.map((r) => [r.sample_text, r]))
    expect(byName['Kortköp 260828 KRONANS APOTEK AB']).toMatchObject({ source: 'directory', display_name: 'Kronans Apotek', band: 'link', company_id: COMPANY })
    expect(byName['SQSP  WORKSP']).toMatchObject({ source: 'directory', display_name: 'Squarespace', party_id: 'p-sq', band: 'link' })
    expect(byName['Lön Jakob Juni Överföring via internet']).toMatchObject({ kind: 'payroll', band: 'nil', display_name: null })
  })

  it('links a text the company booked before to its own party, without the model', async () => {
    mock.enqueue({ data: [{ id: 't1', original_description: 'Kontorsplatser Oktober', description: 'Kontorsplatser Oktober', amount: -12000, currency: 'SEK', merchant_name: null }] })
    mock.enqueue({ data: [] }) // live aliases
    mock.enqueue({ data: [] }) // document hits
    mock.enqueue({ data: [{ id: 'p-k', display_name: 'Kontorsplatser i Stockholm AB', alias_keys: [ledgerKey('Kontorsplatser Oktober')], status: 'confirmed' }] })
    mock.enqueue({ data: [] }) // giro numbers
    mock.enqueue({ data: [] }) // directory table: the seed does not know the text
    mock.enqueue({ data: null }) // insert
    const summary = await resolveCompanyCounterparts(mock.supabase as unknown as SupabaseClient, COMPANY, { useModel: false })
    expect(summary.bySource.ledger).toBe(1)
    expect(summary.modelLines).toBe(0)
    const inserted = mock.findCall('counterparty_aliases', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(inserted[0]).toMatchObject({ party_id: 'p-k', display_name: 'Kontorsplatser i Stockholm AB', source: 'ledger', band: 'link' })
  })

  it('returns early when every string already has a live alias', async () => {
    mock.enqueue({ data: [{ id: 't1', original_description: 'SQSP  WORKSP', description: null, amount: -92, currency: 'SEK', merchant_name: null }] })
    mock.enqueue({ data: [{ alias_key: 'sqsp worksp' }] })
    const summary = await resolveCompanyCounterparts(mock.supabase as unknown as SupabaseClient, COMPANY, { useModel: false })
    expect(summary).toMatchObject({ strings: 1, alreadyResolved: 1, planned: 0, written: 0 })
    expect(mock.findCall('counterparty_aliases', 'insert')).toBeUndefined()
  })
})
