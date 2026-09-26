import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/arkiv/map', () => ({ buildArkivMap: vi.fn() }))
import { buildArkivMap } from '@/lib/arkiv/map'
import { effectiveKnowledge, loadAgentBundle, loadAgentsOverview } from '../agent-bundle'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const atom = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tier: id.startsWith('vertical/') ? 'vertical' : 'horizontal', title: id.split('/').pop(), description: `About ${id}. More text.`,
  version: 3, reviewed_at: '2026-09-02', is_active: true, mcp_exposed: true, parent_atom_id: id.split('/').length > 2 ? id.split('/').slice(0, 2).join('/') : null, ...extra,
})

beforeEach(() => { reset(); vi.mocked(buildArkivMap).mockReset() })

describe('loadAgentsOverview', () => {
  it('attaches knowledge, company atoms and connection states to every agent', async () => {
    enqueue({ data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } })
    enqueue({ data: [] }) // company_agent_knowledge
    enqueue({ data: [
      atom('horizontal/swedish-vat'), atom('horizontal/swedish-accounting-compliance'),
      atom('horizontal/swedish-vat/vat-compliance-reference'),
      atom('horizontal/swedish-payroll', { is_active: false }),
      atom('vertical/konsult-it'),
    ] })
    enqueue({ count: 1 }) // bank_connections
    enqueue({ data: [] }) // skatteverket_tokens
    enqueue({ data: null }) // peppol_access
    enqueue({ data: [{ predicate: 'vat_period' }, { predicate: 'vat_method' }, { predicate: 'board' }] }) // company_facts
    enqueue({ count: 2 }) // agreements
    enqueue({ count: 5 }) // agent_memory
    enqueue({ count: 300 }) // document_attachments
    const overview = await loadAgentsOverview(supabase as never, 'company-a')

    expect(overview).toMatchObject({ facts: 3, agreements: 2, remembered: 5, documents: 300 })
    const vat = overview.agents.find((a) => a.id === 'quarterly-vat-review')!
    expect(vat.knowledge.map((k) => k.id)).toEqual(['horizontal/swedish-vat', 'horizontal/swedish-accounting-compliance'])
    expect(vat.knowledge[0]).toMatchObject({ reviewed_at: '2026-09-02', version: 3, summary: 'About horizontal/swedish-vat. More text.' })
    expect(vat.references.map((r) => r.id)).toEqual(['horizontal/swedish-vat/vat-compliance-reference'])
    expect(vat.company).toEqual([{ id: 'vertical/konsult-it', title: 'konsult-it', tier: 'vertical' }])
    expect(vat.connections).toEqual([{ kind: 'skatteverket', status: 'missing', settings_href: '/settings/tax' }])
    // the VAT agent reads vat_period and vat_method, not the board
    expect(vat.facts_known).toBe(2)

    // a switched-off pack never shows as the agent's knowledge
    expect(overview.agents.find((a) => a.id === 'payroll-monthly')!.knowledge).toEqual([])
    const bookkeep = overview.agents.find((a) => a.id === 'bookkeep')!
    expect(bookkeep.connections).toEqual([{ kind: 'bank', status: 'connected' }, { kind: 'mail', status: 'in_ai' }])
  })

  it('reports a failed connection read as unknown, never as missing', async () => {
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: [{ status: 'active' }] })
    enqueue({ data: { status: 'enabled' } })
    enqueue({ error: { message: 'facts down' } })
    enqueue({ count: 0 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })
    const overview = await loadAgentsOverview(supabase as never, 'company-a')
    const month = overview.agents.find((a) => a.id === 'month-end-close')!
    expect(month.connections).toEqual([{ kind: 'bank', status: 'unknown' }, { kind: 'skatteverket', status: 'connected' }])
    // no agent waits on Peppol (invoices go out by e-mail)
    expect(overview.agents.find((a) => a.id === 'kreditfaktura-process')!.connections).toEqual([])
  })
})

describe('loadAgentBundle', () => {
  it('inlines knowledge bodies and uses the client-specific Kvittojakten workflow', async () => {
    vi.mocked(buildArkivMap).mockRejectedValue(new Error('archive down'))
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: [atom('horizontal/swedish-accounting-compliance', { body: '# BFL' }), atom('horizontal/swedish-invoice-compliance', { body: '# Faktura' })] })
    enqueue({ data: [atom('horizontal/swedish-invoice-compliance/invoice-rules')] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null }) // profile summary
    enqueue({ data: [] }) // memory
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', 'kvittojakten', 'chatgpt'))!
    expect(bundle.workflow.slug).toBe('kvittojakten-chatgpt')
    expect(bundle.workflow.body.length).toBeGreaterThan(100)
    expect(bundle.knowledge.map((k) => [k.id, k.body])).toEqual([['horizontal/swedish-accounting-compliance', '# BFL'], ['horizontal/swedish-invoice-compliance', '# Faktura']])
    expect(bundle.references).toEqual([{ id: 'horizontal/swedish-invoice-compliance/invoice-rules', title: 'invoice-rules' }])
    expect(bundle.connections).toEqual([{ kind: 'mail', status: 'in_ai' }, { kind: 'browser', status: 'in_ai' }])
    expect(bundle.industry_sections).toEqual([])
  })
})

describe('loadAgentBundle: company knowledge', () => {
  it('inlines the facts this agent acts on, in its order, with agreements only when it reads them', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue({
      company: { name: 'Arcim Technology AB', org_number: '5595386219', record_ref: 'company:x' },
      documents: { total: 300, by_group: {} as never, latest: [] },
      agreements: [{ record_ref: 'agreement:1', title: 'Lån Almi', kind: 'loan', counterparty: 'Almi', amount: 10417, period: 'monthly', ends_on: '2031-02-02', next_payment: '2026-10-02' }],
      company_facts: [
        { predicate: 'board', label: 'Styrelse', value: 'A, B', valid_from: null },
        { predicate: 'accounting_method', label: 'Bokföringsmetod', value: 'Faktureringsmetoden', valid_from: null },
        { predicate: 'vat_method', label: 'Redovisningsmetod', value: 'Kontantmetoden', valid_from: '2025-10-09' },
      ],
      waiting: { questions: 0, findings: 0 },
      how_to: ['Find: accounted_search_records'],
    })
    const run = async (id: 'quarterly-vat-review' | 'year-end-close') => {
      enqueue({ data: null }); enqueue({ data: [] }); enqueue({ data: [] }); enqueue({ data: [] })
      enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
      enqueue({ data: { profile_summary: 'IT-konsult i Stockholm.' } })
      enqueue({ data: [{ content: 'Representation bokförs alltid på 6071.' }] })
      return (await loadAgentBundle(supabase as never, 'company-a', id))!
    }
    const vat = (await run('quarterly-vat-review')).company_knowledge
    expect(vat.facts.map((f) => f.label)).toEqual(['Redovisningsmetod', 'Bokföringsmetod'])
    expect(vat).not.toHaveProperty('agreements')
    expect(vat).toMatchObject({ name: 'Arcim Technology AB', onboarding_summary: 'IT-konsult i Stockholm.', remembered: ['Representation bokförs alltid på 6071.'], documents: { total: 300 } })
    const yearEnd = (await run('year-end-close')).company_knowledge
    expect(yearEnd.facts.map((f) => f.label)).toEqual(['Bokföringsmetod', 'Styrelse'])
    expect(yearEnd.agreements?.map((a) => a.title)).toEqual(['Lån Almi'])
  })
})

describe('effectiveKnowledge', () => {
  it('keeps defaults in order, drops what the company took away and appends what it added', () => {
    const choice = { added: ['vertical/bygg-hantverk', 'horizontal/swedish-vat'], removed: new Set(['horizontal/swedish-accounting-compliance']) }
    expect(effectiveKnowledge(['horizontal/swedish-vat', 'horizontal/swedish-accounting-compliance'], choice)).toEqual([
      { id: 'horizontal/swedish-vat', source: 'default' },
      { id: 'vertical/bygg-hantverk', source: 'added' },
    ])
    expect(effectiveKnowledge(['horizontal/swedish-vat'], undefined)).toEqual([{ id: 'horizontal/swedish-vat', source: 'default' }])
  })
})

describe('loadAgentBundle: the company chooses the knowledge', () => {
  it('inlines added packs within the budget and lists what does not fit as a reference', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    enqueue({ data: null }) // profile atoms
    enqueue({ data: [
      { agent_id: 'quarterly-vat-review', atom_id: 'horizontal/swedish-accounting-compliance', included: false },
      { agent_id: 'quarterly-vat-review', atom_id: 'vertical/bygg-hantverk', included: true },
      { agent_id: 'quarterly-vat-review', atom_id: 'horizontal/swedish-e-invoicing', included: true },
    ] })
    enqueue({ data: [
      atom('horizontal/swedish-vat', { body: 'v'.repeat(30_000) }),
      atom('vertical/bygg-hantverk', { body: 'b'.repeat(28_000) }),
      atom('horizontal/swedish-e-invoicing', { body: 'e'.repeat(9_000) }),
    ] })
    enqueue({ data: [] }) // references + profile atoms
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null }) // connections
    enqueue({ data: null }); enqueue({ data: [] }) // summary, memory
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', 'quarterly-vat-review'))!
    expect(bundle.knowledge.map((k) => [k.id, k.source])).toEqual([['horizontal/swedish-vat', 'default'], ['vertical/bygg-hantverk', 'added']])
    expect(bundle.references[0]).toEqual({ id: 'horizontal/swedish-e-invoicing', title: 'swedish-e-invoicing' })
  })

  it('runs an own agent with its own instruction, the accounting law by default and the knowledge chosen for it', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    const ownId = '00000000-0000-4000-8000-000000000001'
    enqueue({ data: { team_id: null } }) // companies
    enqueue({ data: [{ id: ownId, company_id: 'company-a', team_id: null, atom_id: null, name: 'Påminnelse', description: 'Mejlar listan', body: '# Steg', share_status: 'private', draft: false }] })
    enqueue({ data: null })
    enqueue({ data: [{ agent_id: `own/${ownId}`, atom_id: 'horizontal/swedish-vat', included: true }] })
    enqueue({ data: [atom('horizontal/swedish-accounting-compliance', { body: '# BFL' }), atom('horizontal/swedish-vat', { body: '# Moms' })] })
    enqueue({ data: [] })
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
    enqueue({ data: null }); enqueue({ data: [] })
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', `own/${ownId}`))!
    expect(bundle.agent.name).toBe('Påminnelse')
    expect(bundle.knowledge.map((k) => [k.id, k.source])).toEqual([['horizontal/swedish-accounting-compliance', 'default'], ['horizontal/swedish-vat', 'added']])
    expect(bundle.connections).toEqual([])
  })

  it('inlines the company\'s own knowledge given to a flow, as it does a pack', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    const ownId = '00000000-0000-4000-8000-000000000001'
    const rulesId = '00000000-0000-4000-8000-0000000000aa'
    const skills = [
      { id: ownId, company_id: 'company-a', team_id: null, atom_id: null, name: 'Påminnelse', description: 'Mejlar listan', body: '# Steg', share_status: 'private', draft: false, kind: 'workflow' },
      { id: rulesId, company_id: 'company-a', team_id: null, atom_id: null, name: 'Våra SaaS-leverantörer', description: 'Hur vi konterar', body: '# Våra regler\n\n6540.', share_status: 'private', draft: false, kind: 'rules' },
    ]
    enqueue({ data: { team_id: null } }) // companies
    enqueue({ data: skills })
    enqueue({ data: null }) // profile atoms
    enqueue({ data: [{ agent_id: `own/${ownId}`, atom_id: null, own_skill_id: rulesId, included: true }] })
    enqueue({ data: [atom('horizontal/swedish-accounting-compliance', { body: '# BFL' })] })
    enqueue({ data: { team_id: null } }) // companies, for the own knowledge
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null }) // connections
    enqueue({ data: null }); enqueue({ data: [] }) // summary, memory
    enqueue({ data: skills }) // the own knowledge
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', `own/${ownId}`))!
    expect(bundle.knowledge.map((k) => [k.id, k.tier, k.source, k.title])).toEqual([
      ['horizontal/swedish-accounting-compliance', 'horizontal', 'default', 'swedish-accounting-compliance'],
      [`own/${rulesId}`, 'own', 'added', 'Våra SaaS-leverantörer'],
    ])
    expect(bundle.knowledge[1].body).toContain('6540')
  })

  it('returns null for an unknown agent', async () => {
    expect(await loadAgentBundle(supabase as never, 'company-a', 'nope')).toBeNull()
  })
})

describe('industry sections by area', () => {
  const pack = atom('vertical/konsult-it', { title: 'IT-konsult & systemutvecklare' })
  const section = (slug: string, areas: string[] | null, extra: Record<string, unknown> = {}) =>
    atom(`vertical/konsult-it/${slug}`, { title: slug, trigger_signals: areas ? { areas } : {}, ...extra })

  /** Queue one curated bundle run for a konsult-it company: knowledge bodies, then the sections. */
  const runBundle = async (id: string, knowledge: unknown[], sections: unknown[]) => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    enqueue({ data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } })
    enqueue({ data: [] }) // choices
    enqueue({ data: knowledge })
    enqueue({ data: [pack] }) // references + profile atoms
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null }) // connections
    enqueue({ data: null }); enqueue({ data: [] }) // summary, memory
    enqueue({ data: sections })
    return (await loadAgentBundle(supabase as never, 'company-a', id))!
  }

  it('inlines only the sections whose areas meet the flow, without their frontmatter', async () => {
    const bundle = await runBundle('invoicing-rules', [atom('horizontal/swedish-invoice-compliance', { body: '# Faktura' })], [
      section('invoice-templates', ['fakturering'], { body: '---\nareas: [fakturering]\n---\n\n# Invoice text library' }),
      section('3-12-rules', ['bokslut'], { body: '# 3:12' }),
      section('consultant-vs-employee', null, { body: '# Untagged' }),
      section('switched-off', ['fakturering'], { body: '# Off', is_active: false }),
    ])
    expect(bundle.industry_sections).toEqual([
      { id: 'vertical/konsult-it/invoice-templates', title: 'invoice-templates', parent_id: 'vertical/konsult-it', body: '# Invoice text library' },
    ])
    expect(bundle.references.map((r) => r.id)).not.toContain('vertical/konsult-it/3-12-rules')
    expect(bundle.company).toEqual([{ id: 'vertical/konsult-it', title: 'IT-konsult & systemutvecklare', tier: 'vertical' }])
    expect(findCalls('agent_atom_registry', 'in')).toContainEqual(['parent_atom_id', ['vertical/konsult-it']])
  })

  it('shares the budget with the knowledge and lists the sections that do not fit as references', async () => {
    const bundle = await runBundle('year-end-close', [atom('horizontal/swedish-year-end-closing', { body: 'y'.repeat(50_000) })], [
      section('3-12-rules', ['bokslut'], { body: 'a'.repeat(6_000) }),
      section('software-capitalization', ['bokslut'], { body: 'b'.repeat(6_000) }),
    ])
    expect(bundle.industry_sections.map((s) => s.id)).toEqual(['vertical/konsult-it/3-12-rules'])
    expect(bundle.references[0]).toEqual({ id: 'vertical/konsult-it/software-capitalization', title: 'software-capitalization' })
  })

  it('skips the sections of a pack that is switched off', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    enqueue({ data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] }) // the pack itself is not live
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
    enqueue({ data: null }); enqueue({ data: [] })
    enqueue({ data: [section('invoice-templates', ['fakturering'], { body: '# Invoice' })] })
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', 'invoicing-rules'))!
    expect(bundle.industry_sections).toEqual([])
  })

  it('does not query sections without profile atoms', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    enqueue({ data: null }); enqueue({ data: [] }); enqueue({ data: [] }); enqueue({ data: [] })
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
    enqueue({ data: null }); enqueue({ data: [] })
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', 'invoicing-rules'))!
    expect(bundle.industry_sections).toEqual([])
    expect(findCalls('agent_atom_registry', 'in').some(([col]) => col === 'parent_atom_id')).toBe(false)
  })

  it('leaves an own agent without sections even when the company has packs', async () => {
    vi.mocked(buildArkivMap).mockResolvedValue(null as never)
    const ownId = '00000000-0000-4000-8000-000000000002'
    enqueue({ data: { team_id: null } })
    enqueue({ data: [{ id: ownId, company_id: 'company-a', team_id: null, atom_id: null, name: 'Egen', description: 'x', body: '# Steg', share_status: 'private', draft: false }] })
    enqueue({ data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } })
    enqueue({ data: [] }) // no knowledge chosen: the own default only
    enqueue({ data: [atom('horizontal/swedish-accounting-compliance', { body: '# BFL' })] })
    enqueue({ data: [pack] })
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
    enqueue({ data: null }); enqueue({ data: [] })
    const bundle = (await loadAgentBundle(supabase as never, 'company-a', `own/${ownId}`))!
    expect(bundle.industry_sections).toEqual([])
    expect(bundle.company.map((c) => c.id)).toEqual(['vertical/konsult-it'])
    expect(findCalls('agent_atom_registry', 'in').some(([col]) => col === 'parent_atom_id')).toBe(false)
  })

  it('names each agent\'s sections in the overview, without bodies', async () => {
    enqueue({ data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } })
    enqueue({ data: [] })
    enqueue({ data: [pack] })
    enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ data: null })
    enqueue({ data: [] }); enqueue({ count: 0 }); enqueue({ count: 0 }); enqueue({ count: 0 })
    enqueue({ data: [
      section('invoice-templates', ['fakturering']),
      section('electronic-services-classification', ['moms']),
      section('3-12-rules', ['bokslut']),
      section('consultant-vs-employee', null),
    ] })
    const overview = await loadAgentsOverview(supabase as never, 'company-a')
    const byAgent = (id: string) => overview.agents.find((a) => a.id === id)!.industry_sections
    expect(byAgent('invoicing-rules')).toEqual([{ id: 'vertical/konsult-it/invoice-templates', title: 'invoice-templates', parent_id: 'vertical/konsult-it' }])
    expect(byAgent('quarterly-vat-review').map((s) => s.id)).toEqual(['vertical/konsult-it/electronic-services-classification'])
    expect(byAgent('month-end-close').map((s) => s.id)).toEqual(['vertical/konsult-it/electronic-services-classification'])
    expect(byAgent('tax-planning').map((s) => s.id)).toEqual(['vertical/konsult-it/3-12-rules'])
    expect(byAgent('payroll-monthly')).toEqual([])
    expect(findCalls('agent_atom_registry', 'select').some(([cols]) => String(cols).includes('body'))).toBe(false)
  })
})
