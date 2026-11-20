import { describe, expect, it } from 'vitest'
import { briefingText, clientDisplayName, describeContextWindow, type ContextFactItem } from '../context-window'

const BRIEFING = {
  company: { id: 'c1', company_id: 'c1', name: 'Exempelbolaget AB', org_number: '559999-0000', entity_type: 'aktiebolag', accounting_method: 'accrual' },
  user_name: 'Anna',
  profile_summary: 'Konsultbolag inom IT.',
  atoms: [{ id: 'horizontal/swedish-vat', atom_id: 'horizontal/swedish-vat', tier: 'horizontal', title: 'Swedish VAT', description: 'Moms.' }],
  memory: [
    { id: 'f1', fact_id: 'f1', kind: 'fact', content: 'Hyran betalas kvartalsvis.', relevance_score: 1, saved_at: '2026-11-01T10:00:00Z', origin: 'conversation', client: 'claude-code' },
    { id: 'f2', fact_id: 'f2', kind: 'preference', content: 'Svara kort.', relevance_score: null, saved_at: null },
  ],
  memory_sync: { last_synced_at: null, note: 'Offer once.' },
  where_to_find: ['memory: facts', 'ledger_context: patterns'],
  data_status: { bank_last_synced_at: '2026-11-09T06:00:00Z' },
  ledger_context: {
    resource_uri: 'Accounted://ledger/context',
    top_counterparty_patterns: [{ counterparty: 'Nordnät AB', dominant_category: 'x', dominant_account_number: '6212', evidence: { seen_12m: 14, agree: 14, last_booked: '2026-10-28' } }],
    top_supplier_patterns: [{ supplier: 'Adobe', dominant_account_number: '5420', vat_treatment: 'reverse_charge', evidence: { seen_12m: 12, agree: 11, last_booked: '2026-10-02' } }],
  },
  inbox: { address: 'inbox@example.test', note: 'Forward mail here.' },
  measures: { tool: 'gnubok_get_measure', how: 'Defined figures.' },
  unexplained: { tool: 'gnubok_list_unexplained', as_of: '2026-11-09', unexplained: 2, cannot_check: 0, top: [{ check_id: 'bank', name_sv: 'Bank mot bokföring', subject: '1930', difference: 100, unit: 'SEK' }], how: 'x' },
  recommended_tools: [{ workflow: 'categorize_month', description: 'd', tools: [] }],
  feedback_channel: { tool: 'gnubok_feedback', when: 'w', include: 'i' },
  some_future_digest: { anything: true },
}

describe('describeContextWindow', () => {
  const window = describeContextWindow(BRIEFING, 60_000)

  it('names the company scope and no group without group facts', () => {
    expect(window.scope.company).toEqual({ company_id: 'c1', name: 'Exempelbolaget AB', org_number: '559999-0000' })
    expect(window.scope.group).toBeNull()
  })

  it('counts the whole text the agent reads', () => {
    expect(window.total_chars).toBe(briefingText(BRIEFING).length)
    expect(briefingText(BRIEFING)).toBe(JSON.stringify(BRIEFING, null, 2))
  })

  it('puts every briefing key in exactly one part, in page order', () => {
    expect(window.sections.map((s) => s.id)).toEqual(['memory', 'company', 'patterns', 'books', 'instructions', 'other'])
    const keys = window.sections.flatMap((s) => s.keys).sort()
    expect(keys).toEqual(Object.keys(BRIEFING).sort())
  })

  it('never hides a key it does not know: it lands in other with its size', () => {
    const other = window.sections.find((s) => s.id === 'other')!
    expect(other.items).toEqual([{ type: 'key', key: 'some_future_digest', chars: expect.any(Number) }])
    expect(other.chars).toBeGreaterThan(0)
  })

  it('sizes each part from its keys, and the parts roughly add up to the whole', () => {
    const sum = window.sections.reduce((n, s) => n + s.chars, 0)
    expect(sum).toBeLessThanOrEqual(window.total_chars)
    expect(sum).toBeGreaterThan(window.total_chars * 0.9)
  })

  it('lists each remembered fact with who saved it, from where and when', () => {
    const memory = window.sections.find((s) => s.id === 'memory')!
    const facts = memory.items.filter((i): i is ContextFactItem => i.type === 'fact')
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ fact_id: 'f1', scope: 'company', content: 'Hyran betalas kvartalsvis.', client: 'claude-code', origin: 'conversation', saved_at: '2026-11-01T10:00:00Z', created_by: null })
    expect(facts[1]).toMatchObject({ fact_id: 'f2', kind: 'preference', client: null, origin: null, saved_at: null })
  })

  it('weighs the remembered facts as their budget does: the fact text only', () => {
    const textChars = 'Hyran betalas kvartalsvis.'.length + 'Svara kort.'.length
    expect(window.memory_budget).toEqual({ used: textChars, budget: 60_000, truncated: false })
    const memory = window.sections.find((s) => s.id === 'memory')!
    // The part's size is the whole text the agent reads for it (ids, kinds, dates); the fact text is a share of it.
    expect(memory.fact_chars).toBe(textChars)
    expect(memory.chars).toBeGreaterThan(memory.fact_chars)
  })

  it('names no tool and no internal profile: measures, feedback and workflows are said in words', () => {
    const items = window.sections.flatMap((s) => s.items)
    const values = items.filter((i) => i.type === 'value').map((i) => (i as { value: string }).value)
    expect(values.some((v) => v.startsWith('gnubok_'))).toBe(false)
    expect(items).toContainEqual({ type: 'value', label: 'measures', value: 'available', source: 'accounted', date: null })
    expect(items).toContainEqual({ type: 'value', label: 'feedback', value: 'available', source: 'accounted', date: null })
    expect(items).toContainEqual({ type: 'value', label: 'workflows', value: '1', source: 'accounted', date: null })
  })

  it('shows the packages a company has off, and nothing for the profile name', () => {
    const none = describeContextWindow({ ...BRIEFING, capabilities_profile: { id: 'standard', name_sv: 'Standard', packages_off: [] } }, 60_000)
    expect(none.sections.flatMap((s) => s.items).filter((i) => i.type === 'value' && i.label === 'packages_off')).toEqual([])
    const off = describeContextWindow({ ...BRIEFING, capabilities_profile: { id: 'standard', name_sv: 'Standard', packages_off: ['payroll', 'webshop'] } }, 60_000)
    expect(off.sections.flatMap((s) => s.items)).toContainEqual({ type: 'value', label: 'packages_off', value: 'payroll,webshop', source: 'settings', date: null })
  })

  it('reads patterns as counterparty to account, with the evidence and the last booking', () => {
    const patterns = window.sections.find((s) => s.id === 'patterns')!
    expect(patterns.items).toEqual([
      { type: 'text', text: 'Nordnät AB → 6212', detail: null, source: 'ledger', date: '2026-10-28', evidence: { agree: 14, seen: 14 } },
      { type: 'text', text: 'Adobe → 5420', detail: null, source: 'ledger', date: '2026-10-02', evidence: { agree: 11, seen: 12 }, vat_treatment: 'reverse_charge' },
    ])
  })

  it('reads the company block as labelled values from the settings', () => {
    const company = window.sections.find((s) => s.id === 'company')!
    expect(company.items).toContainEqual({ type: 'value', label: 'org_number', value: '559999-0000', source: 'settings', date: null })
    expect(company.items).toContainEqual({ type: 'text', text: 'Konsultbolag inom IT.', detail: null, source: 'profile', date: null })
  })

  it('reads the checks with their date', () => {
    const books = window.sections.find((s) => s.id === 'books')!
    expect(books.items).toContainEqual({ type: 'value', label: 'unexplained', value: '2', source: 'checks', date: '2026-11-09' })
    expect(books.items).toContainEqual({ type: 'text', text: 'Bank mot bokföring', detail: '1930', source: 'checks', date: '2026-11-09', result: { difference: 100, unit: 'SEK' } })
  })

  it('takes the group scope and its facts from group_memory, sharing the budget', () => {
    const withGroup = describeContextWindow(
      {
        ...BRIEFING,
        group_memory: { group_name: 'Kontor Göteborg', group_kind: 'byra', facts: [{ fact_id: 'g1', kind: 'fact', content: 'Omvänd byggmoms.', saved_at: '2026-03-12', created_by: 'Anna Berg' }] },
      },
      60_000,
    )
    expect(withGroup.scope.group).toEqual({ name: 'Kontor Göteborg', kind: 'byra' })
    expect(withGroup.sections[0].id).toBe('group')
    expect(withGroup.sections[0].family).toBe('taught')
    expect(withGroup.sections[0].items[0]).toMatchObject({ type: 'fact', scope: 'group', created_by: 'Anna Berg' })
    expect(withGroup.memory_budget.used).toBe(window.memory_budget.used + 'Omvänd byggmoms.'.length)
  })

  it('reads the saver once the briefing carries it', () => {
    const w = describeContextWindow({ ...BRIEFING, memory: [{ fact_id: 'f9', kind: 'fact', content: 'x y', created_by_deleted: true }] }, 60_000)
    expect(w.sections[0].items[0]).toMatchObject({ created_by: null, created_by_deleted: true })
  })

  it('says when the memory was cut at its budget', () => {
    const w = describeContextWindow({ ...BRIEFING, memory_truncated: true }, 60_000)
    expect(w.memory_budget.truncated).toBe(true)
  })

  it('skips facts it cannot read instead of failing', () => {
    const w = describeContextWindow({ ...BRIEFING, memory: [null, { content: 'no id' }, 'text'] }, 60_000)
    expect(w.sections.find((s) => s.id === 'memory')!.items).toEqual([])
  })
})

describe('clientDisplayName', () => {
  it('names the clients the MCP server labels', () => {
    expect(clientDisplayName('claude-code')).toBe('Claude Code')
    expect(clientDisplayName('claude-connector')).toBe('Claude')
    expect(clientDisplayName('chatgpt')).toBe('ChatGPT')
  })

  it('answers null for a label it does not know', () => {
    expect(clientDisplayName('other')).toBeNull()
    expect(clientDisplayName(null)).toBeNull()
  })
})
