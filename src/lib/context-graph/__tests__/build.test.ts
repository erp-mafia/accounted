import { describe, expect, it } from 'vitest'
import { buildContextGraph, chipFamily, GRAPH_CAPS, parseBriefingText, plainName, shortLabel } from '../build'
import type { ContextGraphModel } from '../types'

const fact = (n: number, content: string, extra: Record<string, unknown> = {}) => ({ fact_id: `f${n}`, kind: 'fact', content, saved_at: '2026-11-03T09:12:00Z', ...extra })
const supplier = (name: string, account: string, seen: number, extra: Record<string, unknown> = {}) => ({
  supplier: name,
  dominant_account_number: account,
  evidence: { seen_12m: seen, agree: seen, last_booked: '2026-11-01' },
  ...extra,
})

/** A briefing as gnubok_get_agent_briefing answers (the keys the context view reads). */
const BRIEFING = {
  company: { company_id: 'c1', name: 'Exempelbolaget AB', org_number: '559000-0000' },
  profile_summary: 'Konsultbolag inom IT.',
  atoms: [
    { atom_id: 'horizontal/swedish-vat', title: 'Swedish VAT', description: 'Moms.' },
    { atom_id: 'horizontal/swedish-accounting-compliance', title: 'Swedish Accounting Compliance', description: 'BAS.' },
    { atom_id: 'vertical/konsult-it', title: 'IT-konsult', description: '3:12.' },
  ],
  memory: [
    fact(1, 'Hyran till Kontorshyran betalas kvartalsvis och periodiseras på 5010.', { client: 'claude-connector', created_by: 'Demo' }),
    fact(2, 'Molntjänster från utlandet bokförs med omvänd moms.'),
    fact(3, 'Ägaren vill ha korta svar.', { kind: 'preference' }),
  ],
  data_status: { bank_last_synced_at: '2026-11-09T06:10:00Z' },
  skatteverket_connection: { status: 'active' },
  inbox: { address: 'exempel@inbox.example.test' },
  ledger_context: {
    top_counterparty_patterns: [{ counterparty: 'Kontorshyran AB', dominant_account_number: '5010', evidence: { seen_12m: 4, agree: 4, last_booked: '2026-10-01' } }],
    top_supplier_patterns: [supplier('Molntjänst Inc', '5420', 12, { vat_treatment: 'reverse_charge_services' }), supplier('Fiberbolaget AB', '6212', 12)],
  },
  unexplained: { as_of: '2026-11-09', unexplained: 1, top: [{ check_id: 'bank_balance', name_sv: 'Banken mot bokföringen', subject: '1930', difference: 1249, unit: 'SEK' }] },
  suggestions: [{ title: 'Bankrader att bokföra som tidigare' }],
  recommended_tools: [{ workflow: 'categorize_month' }, { workflow: 'vat_declaration' }],
}

const ids = (m: ContextGraphModel) => m.nodes.map((n) => n.id)
const linked = (m: ContextGraphModel, a: string, b: string) => m.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
const node = (m: ContextGraphModel, id: string) => m.nodes.find((n) => n.id === id)!

describe('buildContextGraph', () => {
  const model = buildContextGraph(BRIEFING)

  it('puts the agent first and draws every kind of thing the briefing holds', () => {
    expect(model.nodes[0]).toMatchObject({ id: 'agent', family: 'agent' })
    expect(ids(model)).toEqual(
      expect.arrayContaining(['fact:f1', 'counterparty:0', 'account:5010', 'account:1930', 'bank', 'skatteverket', 'inbox', 'profile', 'check:0', 'suggestion:0', 'skill:horizontal/swedish-vat', 'workflows']),
    )
    expect(model.empty).toBe(false)
    expect(model.hidden).toBe(0)
  })

  it('is a web, not a star: things link to what they are about', () => {
    const kontorshyran = model.nodes.find((n) => n.kind === 'counterparty' && n.text === 'Kontorshyran AB')!.id
    const moln = model.nodes.find((n) => n.kind === 'counterparty' && n.text === 'Molntjänst Inc')!.id
    // A counterparty hangs on its account, the account on the bookkeeping skill; neither goes straight to the agent.
    expect(linked(model, kontorshyran, 'account:5010')).toBe(true)
    expect(linked(model, 'account:5010', 'skill:horizontal/swedish-accounting-compliance')).toBe(true)
    expect(linked(model, kontorshyran, 'agent')).toBe(false)
    // A fact links to the counterparty and account its text names, and to the skill that governs it.
    expect(linked(model, 'fact:f1', kontorshyran)).toBe(true)
    expect(linked(model, 'fact:f1', 'account:5010')).toBe(true)
    expect(linked(model, 'fact:f2', moln)).toBe(true)
    expect(linked(model, 'fact:f2', 'skill:horizontal/swedish-vat')).toBe(true)
    // A check links to the account it checks and to the bank; a supplier with a VAT treatment to the VAT skill.
    expect(linked(model, 'check:0', 'account:1930')).toBe(true)
    expect(linked(model, 'check:0', 'bank')).toBe(true)
    expect(linked(model, moln, 'skill:horizontal/swedish-vat')).toBe(true)
    expect(linked(model, 'skill:horizontal/swedish-vat', 'skatteverket')).toBe(true)
    expect(linked(model, 'skill:vertical/konsult-it', 'profile')).toBe(true)
  })

  it('stores each link once and only between dots that exist', () => {
    const seen = new Set<string>()
    const known = new Set(ids(model))
    for (const [a, b] of model.edges) {
      expect(a).not.toBe(b)
      expect(known.has(a) && known.has(b)).toBe(true)
      const key = [a, b].sort().join('|')
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
    // Nothing floats free: every dot has at least one link.
    for (const id of known) expect(model.edges.some(([a, b]) => a === id || b === id), id).toBe(true)
  })

  it('counts each chip family as the briefing holds it', () => {
    // taught: 3 facts. read: profile, bank, Skatteverket, inbox and 3 counterparties. wait: 1 check and 1 suggestion. instructions: 3 skills and the workflows.
    expect(model.counts).toEqual({ taught: 3, read: 7, wait: 2, instructions: 4 })
    expect(chipFamily('ref')).toBeNull()
    expect(chipFamily('agent')).toBeNull()
    expect(chipFamily('wait')).toBe('wait')
  })

  it('carries what the panel needs, as the briefing sent it', () => {
    expect(node(model, 'fact:f1')).toMatchObject({ family: 'taught', factKind: 'fact', client: 'claude-connector', savedBy: 'Demo', date: '2026-11-03T09:12:00Z' })
    expect(node(model, 'fact:f1').label).toBe('Hyran till Kontorshyran…')
    const moln = model.nodes.find((n) => n.text === 'Molntjänst Inc')!
    expect(moln).toMatchObject({ label: 'Molntjänst', account: '5420', evidence: { agree: 12, seen: 12 }, vatTreatment: 'reverse_charge_services' })
    expect(node(model, 'check:0')).toMatchObject({ family: 'wait', account: '1930', result: { difference: 1249, unit: 'SEK' } })
    expect(node(model, 'account:5010')).toMatchObject({ family: 'ref', label: '5010' })
    expect(node(model, 'workflows').count).toBe(2)
    expect(node(model, 'skatteverket').status).toBe('active')
  })

  it('orders counterparties by use and merges one named in both lists', () => {
    const m = buildContextGraph({
      ledger_context: {
        top_supplier_patterns: [supplier('Liten AB', '4010', 2), supplier('Stor AB', '4010', 40)],
        top_counterparty_patterns: [{ counterparty: 'stor ab', dominant_account_number: '4010', evidence: { seen_12m: 3, agree: 3 } }],
      },
    })
    const names = m.nodes.filter((n) => n.kind === 'counterparty').map((n) => n.text)
    expect(names).toEqual(['Stor AB', 'Liten AB'])
    expect(m.counts.read).toBe(2)
    // Without the bookkeeping skill the accounts hang on the agent itself.
    expect(linked(m, 'account:4010', 'agent')).toBe(true)
  })

  it('is empty when the briefing holds nothing beside the company', () => {
    for (const briefing of [{}, { company: { name: 'Exempelbolaget AB' } }, { memory: [], atoms: [], ledger_context: {} }]) {
      const m = buildContextGraph(briefing)
      expect(m.empty).toBe(true)
      expect(ids(m)).toEqual(['agent'])
      expect(m.edges).toEqual([])
      expect(m.counts).toEqual({ taught: 0, read: 0, wait: 0, instructions: 0 })
    }
  })

  it('still draws a company with almost nothing', () => {
    const m = buildContextGraph({ profile_summary: 'Nystartat.', atoms: [{ atom_id: 'horizontal/swedish-vat', title: 'Swedish VAT' }] })
    expect(m.empty).toBe(false)
    expect(ids(m)).toEqual(['agent', 'skill:horizontal/swedish-vat', 'profile'])
    expect(m.edges).toHaveLength(2)
  })

  it('caps each kind and folds the rest into one "+N" dot, with the chips keeping the full counts', () => {
    const m = buildContextGraph({
      memory: Array.from({ length: 40 }, (_, i) => fact(i, `Fakta nummer ${i}.`)),
      atoms: BRIEFING.atoms,
      ledger_context: { top_supplier_patterns: Array.from({ length: 30 }, (_, i) => supplier(`Leverantör ${i} AB`, String(4000 + i), 100 - i)) },
    })
    expect(m.nodes.filter((n) => n.kind === 'fact')).toHaveLength(GRAPH_CAPS.facts)
    expect(m.nodes.filter((n) => n.kind === 'counterparty')).toHaveLength(GRAPH_CAPS.counterparties)
    expect(node(m, 'more:fact')).toMatchObject({ kind: 'more', family: 'taught', moreOf: 'fact', count: 40 - GRAPH_CAPS.facts })
    expect(node(m, 'more:counterparty')).toMatchObject({ kind: 'more', family: 'read', moreOf: 'counterparty', count: 30 - GRAPH_CAPS.counterparties })
    expect(m.hidden).toBe(40 - GRAPH_CAPS.facts + 30 - GRAPH_CAPS.counterparties)
    expect(m.counts.taught).toBe(40)
    expect(m.counts.read).toBe(30)
    // The most used are the ones drawn, and the "+N" dots are linked in.
    expect(m.nodes.filter((n) => n.kind === 'counterparty').map((n) => n.text)).toEqual(Array.from({ length: GRAPH_CAPS.counterparties }, (_, i) => `Leverantör ${i} AB`))
    expect(linked(m, 'more:fact', 'agent')).toBe(true)
    expect(linked(m, 'more:counterparty', 'skill:horizontal/swedish-accounting-compliance')).toBe(true)
    // An account is drawn only for a counterparty that is.
    expect(m.nodes.filter((n) => n.kind === 'account')).toHaveLength(GRAPH_CAPS.counterparties)
    // However much the briefing holds, the picture stays bounded.
    expect(m.nodes.length).toBeLessThanOrEqual(90)
  })

  it('takes its own caps', () => {
    const m = buildContextGraph({ memory: [fact(1, 'Ett.'), fact(2, 'Två.'), fact(3, 'Tre.')] }, { ...GRAPH_CAPS, facts: 1 })
    expect(m.nodes.filter((n) => n.kind === 'fact')).toHaveLength(1)
    expect(node(m, 'more:fact').count).toBe(2)
  })

  it('draws group facts on their group, and deadlines, questions and permissions when the briefing carries them', () => {
    const m = buildContextGraph({
      ...BRIEFING,
      group_memory: { group_name: 'Exempelbyrån', facts: [fact(9, 'Månadsstängning senast den 10:e.')] },
      deadlines: [
        { due: '2026-11-12', what: 'Momsdeklaration kvartal 3', amount: 40362, state: 'Förberedd.' },
        { due: '2026-11-12', what: 'Betala Fiberbolaget AB, faktura 12', amount: 499 },
      ],
      open_questions: [{ asked_at: '2026-11-04T22:18:00Z', about: 'Swish, bankrad 28 okt', question: 'Vilken faktura gäller Swishen?' }],
      permissions: { areas: [{ area: 'Bokföring' }, { area: 'Moms' }] },
    })
    expect(linked(m, 'group', 'group_fact:f9')).toBe(true)
    expect(linked(m, 'agent', 'group_fact:f9')).toBe(true)
    expect(linked(m, 'deadline:0', 'skatteverket')).toBe(true)
    expect(linked(m, 'deadline:1', 'bank')).toBe(true)
    expect(linked(m, 'deadline:1', m.nodes.find((n) => n.text === 'Fiberbolaget AB')!.id)).toBe(true)
    expect(linked(m, 'question:0', 'bank')).toBe(true)
    expect(node(m, 'deadline:0')).toMatchObject({ family: 'wait', amount: 40362, date: '2026-11-12', detail: 'Förberedd.' })
    expect(node(m, 'permissions').count).toBe(2)
    expect(m.counts).toEqual({ taught: 4, read: 7, wait: 5, instructions: 5 })
  })

  it('reads nothing into malformed keys', () => {
    const m = buildContextGraph({ memory: 'no', atoms: [null, 3, {}], ledger_context: [], unexplained: { top: [{}] }, group_memory: { facts: [{ content: 'utan id' }] }, deadlines: [{}], data_status: { bank_last_synced_at: '' } })
    expect(m.empty).toBe(true)
  })

  it('is deterministic', () => {
    expect(buildContextGraph(BRIEFING)).toEqual(model)
  })
})

describe('labels', () => {
  it('cuts a sentence at a word and keeps a short one whole', () => {
    expect(shortLabel('Svara kort')).toBe('Svara kort')
    expect(shortLabel('Lagerhyran betalas kvartalsvis i förskott')).toBe('Lagerhyran betalas…')
    expect(shortLabel('Lagerhyran betalas kvartalsvis i förskott').length).toBeLessThanOrEqual(25)
    expect(shortLabel('Enormtlångtordutanmellanslagsomaldrigtarslut')).toBe('Enormtlångtordutanmellan…')
  })

  it('drops the company form from a name', () => {
    expect(plainName('Fiberbolaget AB')).toBe('Fiberbolaget')
    expect(plainName('Telia Sverige AB')).toBe('Telia')
    expect(plainName('Molntjänst Inc')).toBe('Molntjänst')
    expect(plainName('AB')).toBe('AB')
  })
})

describe('parseBriefingText', () => {
  it('reads the text the context view holds, and nothing else', () => {
    expect(parseBriefingText(JSON.stringify({ memory: [] }, null, 2))).toEqual({ memory: [] })
    expect(parseBriefingText('[]')).toBeNull()
    expect(parseBriefingText('not json')).toBeNull()
  })
})
