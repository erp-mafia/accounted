import { describe, expect, it } from 'vitest'
import { aliasKeyOf, bankStatsByKey, composeCounterparts, type AliasRecord } from '../list'
import type { SuggestionReason } from '@/lib/parties/suggest'
import type { RegisterRow } from '../register'

function party(over: Partial<RegisterRow> & { id: string; displayName: string }): RegisterRow {
  return {
    orgNumber: null,
    kind: 'company',
    status: 'confirmed',
    roles: { customerId: null, supplierId: null },
    stats: null,
    invoiceCount: 0,
    reason: null,
    similar: [],
    defaultRoles: ['supplier'],
    createdAt: '2026-01-01',
    country: null,
    ...over,
  }
}

function alias(over: Partial<AliasRecord> & { alias_key: string }): AliasRecord {
  return { party_id: null, display_name: null, kind: 'merchant', rail: null, country: null, what: null, band: 'link', source: 'model', ...over }
}

describe('bankStatsByKey', () => {
  it('keys transactions by the template key and splits money in and out', () => {
    const stats = bankStatsByKey([
      { amount: -200, amount_sek: null, date: '2026-08-01', original_description: 'ANTHROPIC* CLAUDE SUB', description: null, merchant_name: null },
      { amount: -220, amount_sek: -220, date: '2026-09-01', original_description: 'ANTHROPIC* CLAUDE SUB', description: 'renamed', merchant_name: null },
      { amount: 5000, amount_sek: null, date: '2026-07-01', original_description: 'Stripe-betalning Erik', description: null, merchant_name: null },
    ])
    const key = aliasKeyOf({ original_description: 'ANTHROPIC* CLAUDE SUB', description: null, merchant_name: null })
    expect(stats.get(key)).toEqual({ count: 2, inSek: 0, outSek: 420, lastSeen: '2026-09-01' })
  })
})

describe('composeCounterparts', () => {
  it('shows a suggestion by its company name and carries the ledger reason', () => {
    const out = composeCounterparts({
      parties: [party({ id: 'p9', displayName: 'Kontorsplatser j', status: 'suggested', reason: { occurrences: 3 } as SuggestionReason })],
      aliases: [],
      bank: new Map(),
    })
    expect(out.rows[0]).toMatchObject({ name: 'Kontorsplatser', status: 'suggested', reason: { occurrences: 3 }, source: null })
  })

  const anthropicKey = aliasKeyOf({ original_description: 'ANTHROPIC* CLAUDE SUB', description: null, merchant_name: null })
  const bank = bankStatsByKey([
    { amount: -200, amount_sek: null, date: '2026-08-01', original_description: 'ANTHROPIC* CLAUDE SUB', description: null, merchant_name: null },
    { amount: -92, amount_sek: null, date: '2026-08-02', original_description: 'SQSP  WORKSP', description: null, merchant_name: null },
    { amount: -20000, amount_sek: null, date: '2026-08-25', original_description: 'Lön Jakob', description: null, merchant_name: null },
    { amount: -55, amount_sek: null, date: '2026-08-26', original_description: 'UNREAD STRING', description: null, merchant_name: null },
  ])
  const sqspKey = aliasKeyOf({ original_description: 'SQSP  WORKSP', description: null, merchant_name: null })
  const lonKey = aliasKeyOf({ original_description: 'Lön Jakob', description: null, merchant_name: null })

  it('gives a party its bank money when aliases point at it and the ledger money otherwise', () => {
    const out = composeCounterparts({
      parties: [
        party({ id: 'p1', displayName: 'Anthropic', country: 'US' }),
        party({ id: 'p2', displayName: 'Visma Spcs AB', status: 'suggested', stats: { occurrences: 3, expenseSek: 900, revenueSek: 0, firstSeen: '2026-01-01', lastSeen: '2026-06-01', cadenceDays: null, rhythm: null, dominantAccount: '5420', dominantAccountName: 'Programvaror', dominantShare: 1, variants: [] } }),
      ],
      aliases: [alias({ alias_key: anthropicKey, party_id: 'p1', display_name: 'Anthropic', what: 'AI-assistent (Claude), SaaS' })],
      bank,
    })
    const a = out.rows.find((r) => r.id === 'p1')!
    expect(a).toMatchObject({ statsSource: 'bank', count: 1, outSek: 200, what: 'AI-assistent (Claude), SaaS', status: 'confirmed', aliasKeys: [anthropicKey] })
    const v = out.rows.find((r) => r.id === 'p2')!
    // A suggestion that names a legal entity keeps that name: Visma Spcs AB and
    // Visma Solutions Oy are two companies behind one brand.
    expect(v).toMatchObject({ statsSource: 'ledger', count: 3, outSek: 900, account: '5420', status: 'suggested', what: 'Ekonomiprogram, SaaS', name: 'Visma Spcs AB' })
    expect(a.name).toBe('Anthropic')
    // The register comes first: the confirmed counterpart outranks a larger
    // suggestion, so the page reads as a register and not as a queue.
    expect(out.rows.map((r) => r.id)).toEqual(['p1', 'p2'])
  })

  it('lists a reading without a party as its own row and keeps unnamed spend off the list', () => {
    const out = composeCounterparts({
      parties: [],
      aliases: [
        alias({ alias_key: sqspKey, display_name: 'Squarespace', band: 'tentative', what: 'Webbplatsbyggare' }),
        alias({ alias_key: lonKey, display_name: null, kind: 'payroll', band: 'nil' }),
      ],
      bank,
    })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ id: `alias:${sqspKey}`, name: 'Squarespace', status: 'tentative', outSek: 92, partyId: null, defaultRoles: ['supplier'] })
    // The salary line, the Anthropic string nobody has read here, and the unread string.
    expect(out.counts.unnamedTransactions).toBe(3)
    expect(out.counts).toMatchObject({ total: 1, tentative: 1 })
  })

  it('folds a reading with a party\'s name into that party', () => {
    const out = composeCounterparts({
      parties: [party({ id: 'p1', displayName: 'Squarespace' })],
      aliases: [alias({ alias_key: sqspKey, display_name: 'Squarespace' })],
      bank,
    })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ id: 'p1', outSek: 92, aliasKeys: [sqspKey], statsSource: 'bank' })
  })

  it('filters by name, org number or what they sell', () => {
    const out = composeCounterparts({
      parties: [party({ id: 'p1', displayName: 'Anthropic' }), party({ id: 'p2', displayName: 'Visma Spcs AB', orgNumber: '556252-9155' })],
      aliases: [],
      bank: new Map(),
      q: '556252',
    })
    expect(out.rows.map((r) => r.id)).toEqual(['p2'])
    expect(out.counts.total).toBe(2)
  })
})

describe('composeCounterparts: the register comes before the readings', () => {
  const stats = (expenseSek: number) => ({
    expenseSek,
    revenueSek: 0,
    count: 1,
    lastSeen: '2026-09-01',
    account: '6570',
    accountName: 'Bankavgifter',
    dominantAccountName: 'Bankavgifter',
    rhythm: null,
  })

  it('puts confirmed counterparts first, however small, and sorts by money inside each group', () => {
    const out = composeCounterparts({
      parties: [
        party({ id: 'big', displayName: 'Stor nyhet', status: 'suggested', stats: stats(900_000) as never }),
        party({ id: 'small', displayName: 'Liten leverantör', stats: stats(500) as never }),
        party({ id: 'mid', displayName: 'Mellanleverantör', stats: stats(9_000) as never }),
        party({ id: 'newer', displayName: 'Mindre nyhet', status: 'suggested', stats: stats(100) as never }),
      ],
      aliases: [],
      bank: new Map(),
    })
    expect(out.rows.map((r) => r.name)).toEqual([
      'Mellanleverantör',
      'Liten leverantör',
      'Stor nyhet',
      'Mindre nyhet',
    ])
    expect(out.counts).toMatchObject({ confirmed: 2, suggested: 2 })
  })

  it('leaves a register of only confirmed counterparts in money order', () => {
    const out = composeCounterparts({
      parties: [
        party({ id: 'a', displayName: 'A', stats: stats(100) as never }),
        party({ id: 'b', displayName: 'B', stats: stats(700) as never }),
      ],
      aliases: [],
      bank: new Map(),
    })
    expect(out.rows.map((r) => r.name)).toEqual(['B', 'A'])
  })
})

describe('composeCounterparts: a brand names a fragment, never an entity', () => {
  const suggested = (id: string, displayName: string) => party({ id, displayName, status: 'suggested' })

  it('gives a head-of-text fragment the brand behind it', () => {
    const out = composeCounterparts({ parties: [suggested('p1', 'Claude')], aliases: [], bank: new Map() })
    expect(out.rows[0]!.name).toBe('Anthropic')
  })

  it('keeps a legal entity apart from its brand, so two entities stay two rows with two names', () => {
    const out = composeCounterparts({
      parties: [suggested('us', 'Anthropic, PBC'), suggested('ie', 'Anthropic Ireland')],
      aliases: [],
      bank: new Map(),
    })
    expect(out.rows.map((r) => r.name).sort()).toEqual(['Anthropic Ireland', 'Anthropic, PBC'])
  })
})
