import { describe, expect, it, vi } from 'vitest'
import { coreKey, displayNameFromVoucherText } from '../ledger-key'
import type { ObservedParty } from '../observed'
import { buildSuggestions, suggestPartiesForCompany, type ExistingParty, type LedgerKeyEvidence } from '../suggest'

function observed(over: Partial<ObservedParty> & { key: string }): ObservedParty {
  return {
    name: over.key.toUpperCase(),
    variants: [],
    variant_count: 1,
    occurrences: 3,
    expense_sek: 3000,
    revenue_sek: 0,
    first_seen: '2026-01-10',
    last_seen: '2026-03-10',
    cadence_days: 30,
    dominant_account_number: '4000',
    dominant_account_share: 0.6,
    dominant_account_count: 2,
    dominant_account_total: 3,
    label: 'party',
    rhythm: 'monthly',
    ...over,
  }
}

function evidence(over: Partial<LedgerKeyEvidence> & { key: string }): LedgerKeyEvidence {
  return { docs: 0, self_docs: 0, orgs: [], vat_numbers: [], names: [], bankgiro: [], plusgiro: [], ...over }
}

const ORG = '5564300142'

describe('coreKey', () => {
  it('strips AP prefixes, digit runs and legal forms', () => {
    expect(coreKey('levfakt beijer byggmaterial ab 2089')).toBe('beijer byggmaterial')
    expect(coreKey('Fortnox Finans AB')).toBe('fortnox finans')
    expect(coreKey('inköp av varor')).toBe('av varor')
  })
})

describe('displayNameFromVoucherText', () => {
  it('drops AP/AR prefixes and supplier numbers but keeps casing and legal form', () => {
    expect(displayNameFromVoucherText('Levfakt BEIJER BYGGMATERIAL AB (2089)')).toBe('BEIJER BYGGMATERIAL AB')
    expect(displayNameFromVoucherText('Levfakt Beijer Byggmaterial AB, 097')).toBe('Beijer Byggmaterial AB')
    expect(displayNameFromVoucherText('Kundbet Acme Konsult AB')).toBe('Acme Konsult AB')
    expect(displayNameFromVoucherText('Leverantörsfaktura från 18 Loopia')).toBe('Loopia')
    expect(displayNameFromVoucherText('UBER *TRIP HELP.UBER.COM')).toBe('UBER *TRIP HELP.UBER.COM')
    expect(displayNameFromVoucherText('Inköp av varor')).toBe('Inköp av varor')
  })
})

describe('buildSuggestions', () => {
  it('skips keys the pre-classifier does not call party', () => {
    const r = buildSuggestions({
      observed: [observed({ key: 'inköp av varor', label: 'category' }), observed({ key: 'lön mars', label: 'payroll' })],
      evidence: [],
      existing: [],
    })
    expect(r.items).toHaveLength(0)
    expect(r.skipped).toEqual([
      { key: 'inköp av varor', label: 'category' },
      { key: 'lön mars', label: 'payroll' },
    ])
  })

  it('creates a new suggested party from the ledger alone, with ledger facts and a reason', () => {
    const r = buildSuggestions({ observed: [observed({ key: 'beijer byggmaterial' })], evidence: [], existing: [] })
    expect(r.items).toHaveLength(1)
    const item = r.items[0]!
    expect(item.party_id).toBeUndefined()
    expect(item.org_number).toBeUndefined()
    expect(item.origin).toBe('ledger')
    expect(item.display_name).toBe('BEIJER BYGGMATERIAL')
    expect(item.alias_keys).toEqual(['beijer byggmaterial'])
    expect(item.reason.attach).toBe('new')
    expect(item.reason.occurrences).toBe(3)
    expect(item.facts.map((f) => f.field)).toEqual(['dominant_account', 'cadence_days', 'voucher_text'])
    expect(item.identities).toEqual([])
  })

  it('uses the document hard key: org number, printed name, VAT and identities', () => {
    const r = buildSuggestions({
      observed: [observed({ key: 'beijer byggmaterial' })],
      evidence: [
        evidence({
          key: 'beijer byggmaterial',
          docs: 3,
          orgs: [{ org: ORG, n: 3 }],
          vat_numbers: [{ vat: `SE${ORG}01`, n: 3 }],
          names: [{ name: 'Beijer Byggmaterial AB', n: 3 }],
          bankgiro: [{ value: '53170900', n: 3, first_seen: '2026-01-10', last_seen: '2026-03-10' }],
        }),
      ],
      existing: [],
    })
    const item = r.items[0]!
    expect(item.org_number).toBe(ORG)
    expect(item.origin).toBe('document')
    expect(item.display_name).toBe('Beijer Byggmaterial AB')
    expect(item.legal_name).toBe('Beijer Byggmaterial AB')
    expect(item.vat_number).toBe(`SE${ORG}01`)
    expect(item.identities).toEqual([
      { scheme: 'bankgiro', value: '53170900', first_seen: '2026-01-10', last_seen: '2026-03-10', seen_count: 3 },
    ])
    expect(item.facts.map((f) => f.field)).toEqual(['dominant_account', 'cadence_days', 'org_number', 'legal_name', 'voucher_text'])
    expect(item.reason.org_number).toBe(ORG)
  })

  it('withholds the hard key and identities when a key mixes two org numbers', () => {
    const r = buildSuggestions({
      observed: [observed({ key: 'vattenfall' })],
      evidence: [
        evidence({
          key: 'vattenfall',
          docs: 4,
          orgs: [
            { org: ORG, n: 2 },
            { org: '5560125790', n: 2 },
          ],
          bankgiro: [{ value: '51108348', n: 4, first_seen: '2026-01-01', last_seen: '2026-04-01' }],
        }),
      ],
      existing: [],
    })
    const item = r.items[0]!
    expect(item.org_number).toBeUndefined()
    expect(item.identities).toEqual([])
    expect(item.reason.ambiguous_orgs).toEqual([ORG, '5560125790'])
  })

  it('attaches to an existing party by org number, then by exact alias key, never by name', () => {
    const byOrg: ExistingParty = { id: 'p-org', display_name: 'Beijer AB', org_number: ORG, alias_keys: [], status: 'confirmed' }
    const byAlias: ExistingParty = { id: 'p-alias', display_name: 'Loopia', org_number: null, alias_keys: ['loopia'], status: 'suggested' }
    const lookalike: ExistingParty = { id: 'p-fortnox', display_name: 'Fortnox AB', org_number: '5566661012', alias_keys: [], status: 'confirmed' }
    const r = buildSuggestions({
      observed: [observed({ key: 'beijer byggmaterial' }), observed({ key: 'loopia' }), observed({ key: 'fortnox finans' })],
      evidence: [evidence({ key: 'beijer byggmaterial', docs: 1, orgs: [{ org: ORG, n: 1 }] })],
      existing: [byOrg, byAlias, lookalike],
    })
    const [beijer, loopia, fortnox] = r.items
    expect(beijer!.party_id).toBe('p-org')
    expect(beijer!.reason.attach).toBe('org_number')
    expect(loopia!.party_id).toBe('p-alias')
    expect(loopia!.reason.attach).toBe('alias_key')
    // Same trade name is a question for a person, not a merge.
    expect(fortnox!.party_id).toBeUndefined()
    expect(fortnox!.reason.attach).toBe('new')
    expect(fortnox!.reason.similar_to).toBeUndefined()
  })

  it('reports same-core live parties as similar_to on new suggestions', () => {
    const existing: ExistingParty = { id: 'p1', display_name: 'Levfakt Beijer Byggmaterial AB 2089', org_number: null, alias_keys: [], status: 'suggested' }
    const r = buildSuggestions({ observed: [observed({ key: 'beijer byggmaterial' })], evidence: [], existing: [existing] })
    expect(r.items[0]!.party_id).toBeUndefined()
    expect(r.items[0]!.reason.similar_to).toEqual([{ party_id: 'p1', display_name: 'Levfakt Beijer Byggmaterial AB 2089' }])
  })
})

describe('suggestPartiesForCompany', () => {
  function stubClient(opts: { observed: unknown[]; evidence: unknown[]; existing: unknown[]; apply: unknown }) {
    const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === 'get_observed_parties') return { data: opts.observed, error: null }
      if (name === 'get_ledger_key_evidence') return { data: opts.evidence, error: null }
      if (name === 'apply_party_suggestions') return { data: opts.apply, error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    })
    const range = vi.fn(async () => ({ data: opts.existing, error: null }))
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'order']) chain[m] = vi.fn(() => chain)
    chain.range = range
    const from = vi.fn(() => chain)
    return { client: { rpc, from } as never, rpc, from }
  }

  it('runs observed -> evidence -> existing -> apply and sums the RPC summary', async () => {
    const { client, rpc } = stubClient({
      observed: [
        { key: 'beijer byggmaterial', name: 'BEIJER', variants: [], variant_count: 1, occurrences: 3, expense_sek: 3000, revenue_sek: 0, first_seen: '2026-01-10', last_seen: '2026-03-10', cadence_days: 30, dominant_account_number: '4000', dominant_account_share: 0.6, dominant_account_count: 2, dominant_account_total: 3 },
        { key: 'inköp av varor', name: 'Inköp av varor', variants: [], variant_count: 1, occurrences: 1, expense_sek: 300, revenue_sek: 0, first_seen: '2026-03-15', last_seen: '2026-03-15', cadence_days: null, dominant_account_number: '4010', dominant_account_share: 0.5, dominant_account_count: 1, dominant_account_total: 1 },
      ],
      evidence: [],
      existing: [],
      apply: { created: 1, attached: 0, identities: 0, facts: 2 },
    })
    const summary = await suggestPartiesForCompany(client, 'co', 'user')
    expect(summary).toEqual({ observed: 2, suggested: 1, skipped: 1, created: 1, attached: 0, identities: 0, facts: 2 })
    const applyCall = rpc.mock.calls.find((c) => c[0] === 'apply_party_suggestions')!
    const args = applyCall[1] as unknown as { p_company_id: string; p_user_id: string; p_items: Array<{ key: string }> }
    expect(args.p_company_id).toBe('co')
    expect(args.p_user_id).toBe('user')
    expect(args.p_items.map((i) => i.key)).toEqual(['beijer byggmaterial'])
  })

  it('does not call apply when nothing is a party', async () => {
    const { client, rpc } = stubClient({ observed: [], evidence: [], existing: [], apply: null })
    const summary = await suggestPartiesForCompany(client, 'co', 'user')
    expect(summary.suggested).toBe(0)
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('apply_party_suggestions')
  })

  it('surfaces RPC errors', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    await expect(suggestPartiesForCompany({ rpc } as never, 'co', 'user')).rejects.toThrow(/get_observed_parties failed: boom/)
  })
})

describe('similarAmong', () => {
  it('pairs same-core and whole-word-extended names, never unrelated ones', async () => {
    const { similarAmong } = await import('../register')
    const m = similarAmong([
      { id: 'a', display_name: 'Fortnox AB', alias_keys: ['fortnox'] },
      { id: 'b', display_name: 'Fortnox Finans AB', alias_keys: ['fortnox finans'] },
      { id: 'c', display_name: 'Rikshem Uppsala KB', alias_keys: [] },
      { id: 'd', display_name: 'Rikshem', alias_keys: [] },
      { id: 'e', display_name: 'Fortum Markets AB', alias_keys: [] },
      { id: 'f', display_name: 'Levfakt Beijer Byggmaterial AB 2089', alias_keys: ['beijer byggmaterial'] },
      { id: 'g', display_name: 'BEIJER BYGGMATERIAL', alias_keys: [] },
    ])
    expect(m.get('a')!.map((s) => s.id)).toEqual(['b'])
    expect(m.get('b')!.map((s) => s.id)).toEqual(['a'])
    expect(m.get('c')!.map((s) => s.id)).toEqual(['d'])
    expect(m.get('e')).toEqual([])
    expect(m.get('f')!.map((s) => s.id)).toEqual(['g'])
  })
})
