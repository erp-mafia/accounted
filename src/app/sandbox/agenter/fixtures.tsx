'use client'

/**
 * Fixtures for the /sandbox/agenter demo (list and agent pages). Auth-free via
 * the /sandbox middleware exemption. Every /api call the pages make is answered
 * in the browser; nothing reaches a server and nothing is written. Knowledge
 * choices are kept in the page so add, remove and reset can be tried.
 */

import { useState, type ReactNode } from 'react'
import { CompanyProvider } from '@/contexts/CompanyContext'
import DashboardNav from '@/components/dashboard/DashboardNav'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import { AGENTS, OWN_AGENT_KNOWLEDGE, type Area } from '@/lib/agent-skills/agents'
import { REGISTRY_SKILLS } from '@/lib/agent-skills/registry'
import type { AgentsOverview, ConnectionStatus } from '@/lib/agent-skills/agent-bundle'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'

// Titles and versions as agent_atom_registry holds them on prod (2026-09-24).
const PACKS: Record<string, { title: string; version: number }> = {
  'horizontal/swedish-accounting-compliance': { title: 'Swedish Accounting Compliance', version: 5 },
  'horizontal/swedish-asset-accounting': { title: 'Swedish Asset Accounting', version: 4 },
  'horizontal/swedish-financial-reporting': { title: 'Swedish Financial Reporting', version: 3 },
  'horizontal/swedish-invoice-compliance': { title: 'Swedish Invoice Compliance', version: 9 },
  'horizontal/swedish-payroll': { title: 'Swedish Payroll', version: 5 },
  'horizontal/swedish-tax-planning': { title: 'Swedish Tax Planning', version: 3 },
  'horizontal/swedish-vat': { title: 'Swedish VAT', version: 4 },
  'horizontal/swedish-year-end-closing': { title: 'Swedish Year End Closing', version: 3 },
}
const WORKFLOW_VERSION = 4
const CONNECTIONS: Record<string, ConnectionStatus> = { bank: 'connected', skatteverket: 'connected', peppol: 'missing' }
const SETTINGS: Record<string, string> = { bank: '/settings/banking', skatteverket: '/settings/tax', peppol: '/settings/invoicing' }

// Company facts the demo company holds (predicates from lib/arkiv/facts/predicates.ts).
const KNOWN_FACTS = new Set(['legal_name', 'org_number', 'fiscal_year', 'vat_registered', 'vat_period', 'vat_method', 'accounting_method', 'f_skatt', 'sni_codes', 'board', 'share_capital', 'bank_connection', 'monthly_cost_baseline', 'top_counterparty'])

// Every pack a company can choose, as the registry lists them on prod (titles, 2026-09-24).
const OPTIONS: KnowledgeOption[] = [
  ...Object.entries(PACKS).map(([id, p]) => ({ id, tier: 'horizontal' as const, title: p.title, summary: '', version: p.version, reviewed_at: null })),
  { id: 'horizontal/swedish-e-invoicing', tier: 'horizontal', title: 'Swedish E Invoicing', summary: 'Peppol, e-faktura och krav vid offentlig sektor.', version: 7, reviewed_at: null },
  { id: 'horizontal/swedish-sie-import-export', tier: 'horizontal', title: 'Swedish SIE Import Export', summary: 'SIE-filer vid byte av bokföringsprogram.', version: 4, reviewed_at: null },
  { id: 'horizontal/swedish-project-accounting', tier: 'horizontal', title: 'Swedish Project Accounting', summary: 'Projekt, pågående arbeten och bidrag.', version: 3, reviewed_at: null },
  { id: 'horizontal/swedish-sru-filing', tier: 'horizontal', title: 'Swedish SRU Filing', summary: 'SRU-koder till Skatteverket.', version: 7, reviewed_at: null },
  { id: 'vertical/bygg-hantverk', tier: 'vertical', title: 'Bygg & hantverk (SNI 41-43)', summary: 'Omvänd moms i byggsektorn, ROT och pågående arbeten.', version: 3, reviewed_at: null },
  { id: 'vertical/e-handel', tier: 'vertical', title: 'E-handel & näthandel (SNI 47.91 / 47.99)', summary: 'OSS, marknadsplatser och betalleverantörer.', version: 3, reviewed_at: null },
  { id: 'vertical/konsult-it', tier: 'vertical', title: 'IT-konsult & systemutvecklare (SNI 62)', summary: '3:12, konsult eller anställd, elektroniska tjänster.', version: 3, reviewed_at: null },
  { id: 'vertical/reklambyra-marknadsforing', tier: 'vertical', title: 'Reklambyrå & marknadsföring', summary: 'Vidarefakturering och mediainköp.', version: 3, reviewed_at: null },
  { id: 'vertical/restaurang-cafe', tier: 'vertical', title: 'Restaurang & café (SNI 56)', summary: 'Moms på servering och avhämtning, kassaregister och personalliggare.', version: 1, reviewed_at: null },
  { id: 'vertical/vard-halsa', tier: 'vertical', title: 'Vård, tandvård & skönhet (SNI 86)', summary: 'Momsfri vård, blandad verksamhet och frisörer.', version: 1, reviewed_at: null },
  { id: 'vertical/software-saas-ai', tier: 'vertical', title: 'Software, SaaS & AI-produktbolag', summary: 'Prenumerationsintäkter och aktivering av utveckling.', version: 2, reviewed_at: null },
  { id: 'modifier/holding-ab', tier: 'modifier', title: 'Holdingbolag (rena ägar-/förvaltningsbolag)', summary: 'Koncernbidrag, näringsbetingade andelar, moms för holding.', version: 3, reviewed_at: null },
  { id: 'modifier/mixed-verksamhet', tier: 'modifier', title: 'Blandad verksamhet (moms-split)', summary: 'Fördelningsnyckel och jämkning.', version: 3, reviewed_at: null },
  { id: 'modifier/single-shareholder-ab-fmb', tier: 'modifier', title: 'Aktiebolag med en aktieägare (fåmansbolag)', summary: 'Lön eller utdelning, 3:12.', version: 4, reviewed_at: null },
]

// What the demo company changed, kept in the page: add, remove and reset work without a server.
const choices = new Map<string, { added: string[]; removed: Set<string> }>([['bookkeep', { added: ['vertical/konsult-it'], removed: new Set() }]])

function knowledgeFor(defaults: readonly string[], agentId: string) {
  const choice = choices.get(agentId)
  const option = (id: string) => OPTIONS.find((o) => o.id === id)!
  return [
    ...defaults.filter((k) => !choice?.removed.has(k)).map((k) => ({ ...option(k), source: 'default' as const })),
    ...(choice?.added ?? []).filter((k) => !defaults.includes(k)).map((k) => ({ ...option(k), source: 'added' as const })),
  ]
}

function applyChoice(body: { action: 'add' | 'remove' | 'reset'; agent_id: string; atom_id?: string }) {
  const defaults = body.agent_id in AGENTS ? AGENTS[body.agent_id as keyof typeof AGENTS].knowledge : OWN_AGENT_KNOWLEDGE
  const choice = choices.get(body.agent_id) ?? { added: [], removed: new Set<string>() }
  if (body.action === 'reset') { choices.delete(body.agent_id); return }
  const id = body.atom_id!
  if (body.action === 'add') { choice.removed.delete(id); if (!defaults.includes(id) && !choice.added.includes(id)) choice.added.push(id) }
  else { choice.added = choice.added.filter((a) => a !== id); if (defaults.includes(id)) choice.removed.add(id) }
  choices.set(body.agent_id, choice)
}

function overview(): AgentsOverview {
  return {
    ...OVERVIEW,
    own_knowledge: Object.fromEntries(CATALOG.filter((c) => c.slug.startsWith('own/')).map((c) => [c.slug, knowledgeFor(OWN_AGENT_KNOWLEDGE, c.slug)])),
    own_default: knowledgeFor(OWN_AGENT_KNOWLEDGE, 'own/'),
    agents: OVERVIEW.agents.map((a) => ({ ...a, knowledge: knowledgeFor(AGENTS[a.id].knowledge, a.id), references: a.references.filter((r) => knowledgeFor(AGENTS[a.id].knowledge, a.id).some((k) => k.id === r.id.split('/').slice(0, 2).join('/'))), removed: AGENTS[a.id].knowledge.filter((k) => choices.get(a.id)?.removed.has(k)) })),
  }
}

/** The konsult-it sections as tagged in .claude/skills/industry/konsult-it/references. */
const KONSULT_IT_SECTIONS: Array<{ id: string; title: string; areas: Area[] }> = [
  { id: 'vertical/konsult-it/invoice-templates', title: 'Invoice text library: IT consulting (Sweden)', areas: ['fakturering'] },
  { id: 'vertical/konsult-it/electronic-services-classification', title: 'Electronic services classification (moms)', areas: ['moms'] },
  { id: 'vertical/konsult-it/cross-border-payroll', title: 'Cross-border payroll for IT consultants', areas: ['lon'] },
  { id: 'vertical/konsult-it/3-12-rules', title: '3:12-reglerna (IL 57 kap): full reference', areas: ['bokslut'] },
  { id: 'vertical/konsult-it/software-capitalization', title: 'Software capitalization: K3, K2, IFRS', areas: ['bokslut'] },
]

const OVERVIEW: AgentsOverview = {
  facts: KNOWN_FACTS.size,
  agreements: 2,
  remembered: 4,
  documents: 312,
  own_knowledge: { 'own/00000000-0000-4000-8000-000000000001': [{ id: 'horizontal/swedish-invoice-compliance', tier: 'horizontal', source: 'added', title: 'Swedish Invoice Compliance', summary: '', version: 9, reviewed_at: null }] },
  own_default: [],
  agents: REGISTRY_SKILLS.map(({ id }) => ({
    id,
    workflow: { slug: id, version: WORKFLOW_VERSION },
    facts_known: AGENTS[id].facts.filter((f) => KNOWN_FACTS.has(f)).length,
    knowledge: [
      ...AGENTS[id].knowledge.map((k) => ({ id: k, tier: 'horizontal', source: 'default' as const, title: PACKS[k]?.title ?? k, summary: '', version: PACKS[k]?.version ?? 1, reviewed_at: null })),
      ...(id === 'bookkeep' ? [{ id: 'vertical/konsult-it', tier: 'vertical', source: 'added' as const, title: 'IT-konsult & systemutvecklare (SNI 62)', summary: '', version: 3, reviewed_at: null }] : []),
    ],
    removed: [],
    references: AGENTS[id].references.map((r) => ({ id: r, title: r.split('/').pop()!.replace(/-/g, ' ') })),
    company: [
      { id: 'vertical/konsult-it', title: 'IT-konsult & systemutvecklare (SNI 62)', tier: 'vertical' as const },
      { id: 'modifier/single-shareholder-ab-fmb', title: 'Aktiebolag med en aktieägare (fåmansbolag)', tier: 'modifier' as const },
    ],
    industry_sections: KONSULT_IT_SECTIONS.filter((s) => s.areas.some((a) => AGENTS[id].areas.includes(a)))
      .map(({ id: sectionId, title }) => ({ id: sectionId, title, parent_id: 'vertical/konsult-it' })),
    connections: AGENTS[id].connections.map((kind) => kind in CONNECTIONS
      ? { kind, status: CONNECTIONS[kind], ...(CONNECTIONS[kind] === 'missing' ? { settings_href: SETTINGS[kind] } : {}) }
      : { kind, status: 'in_ai' as const }),
  })),
}

const OWN_BODY = [
  '# Påminnelse om leverantörsfakturor',
  '',
  '## Steg',
  '1. Hämta obetalda leverantörsfakturor.',
  '2. Välj ut de som förfaller inom 7 dagar.',
  '3. Sortera på förfallodatum och räkna ut totalbeloppet.',
  '4. Visa listan och fråga om betalfil ska skapas.',
].join('\n')

const OWN_BODIES = new Map<string, string>()

const CATALOG: Array<Record<string, unknown> & { slug: string; name: string }> = [
  { slug: 'own/00000000-0000-4000-8000-000000000001', name: 'Påminnelse om leverantörsfakturor', summary: 'Listar obetalda leverantörsfakturor som förfaller inom en vecka.', tags: ['own'], tier: 'own', source: 'own', active: true, shareStatus: 'private', installations: [{ installation_id: '00000000-0000-4000-8000-000000000001', scope: 'company' }] },
]

/**
 * The demo's states, from the URL, so the page can be checked as the users who
 * will see it: ?ai=none (no AI connected), ?roll=viewer (read-only member),
 * ?bolag=ef (an enskild firma with no industry pack, like most companies).
 */
function demoState() {
  const sp = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
  return { noAi: sp.get('ai') === 'none', viewer: sp.get('roll') === 'viewer', firm: sp.get('bolag') === 'ef' }
}

/** The overview as the demo company has it: an enskild firma has no industry or company-form packs. */
function stateOverview(): AgentsOverview {
  const base = overview()
  if (!demoState().firm) return base
  return { ...base, agents: base.agents.map((a) => ({ ...a, company: [], industry_sections: [], knowledge: a.knowledge.filter((k) => !k.id.startsWith('vertical/')) })) }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function installFixtures() {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return real(input, init)
    if (url.pathname === '/api/agents/knowledge' && init?.method === 'PATCH') { applyChoice(JSON.parse(String(init.body))); return json({ ok: true }) }
    // Votes and "fungerar" answers are kept by the page itself in the demo.
    if (url.pathname === '/api/agents/community/feedback') return json({ ok: true })
    // "Skriv själv" in the demo: the item is kept in the page, so it shows under Egna and opens.
    if (url.pathname === '/api/skills' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as { kind: string; item_kind?: 'workflow' | 'rules' | 'analysis'; name: string; description: string; body: string }
      const id = crypto.randomUUID()
      CATALOG.push({ slug: `own/${id}`, name: input.name, summary: input.description, tags: ['own'], tier: 'own', source: 'own', active: true, shareStatus: 'private', installations: [{ installation_id: id, scope: 'company' }], itemKind: input.item_kind ?? 'workflow' } as (typeof CATALOG)[number])
      OWN_BODIES.set(`own/${id}`, input.body)
      return new Response(JSON.stringify({ data: { id } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (init?.method && init.method !== 'GET') return json({ id: 'demo' })
    switch (url.pathname) {
      case '/api/ai/connections': return json(demoState().noAi ? [] : ['claude'])
      case '/api/agents': return json(stateOverview())
      case '/api/agents/knowledge': return json(OPTIONS)
      case '/api/worklist/counts': return json({ counts: { book_transaction: 42, verifikat_missing_document: 9, inbox_document: 3 } })
      case '/api/skills/usage': return json({ bookkeep: { count: 12, last_at: '2026-09-22T09:14:00Z' }, 'quarterly-vat-review': { count: 2, last_at: '2026-08-12T08:00:00Z' } })
      case '/api/skills': {
        const slug = url.searchParams.get('slug')
        if (!slug) return json(CATALOG)
        if (slug === 'own/00000000-0000-4000-8000-000000000001') return json({ body: OWN_BODY })
        if (OWN_BODIES.has(slug)) return json({ body: OWN_BODIES.get(slug) })
        const real = PACK_TEXTS.get(slug)
        if (real) return json({ body: real })
        const section = KONSULT_IT_SECTIONS.find((sec) => sec.id === slug)
        if (section) return json({ body: `# ${section.title}\n\nI appen visas avsnittets egen text här, samma text som din AI läser.` })
        const pack = OPTIONS.find((o) => o.id === slug)
        if (pack) return json({ body: `# ${pack.title}\n\nI appen visas packets egen text här, samma text som din AI läser.` })
        const item = CATALOG.find((c) => c.slug === slug)
        return json({ body: item ? `# ${item.name}\n\n${item.summary}` : '# Accounted workflow' })
      }
      default: return json(null)
    }
  }
}

const COMPANY = {
  company: { id: 'demo-company', name: 'Exempelbolaget AB', entity_type: 'aktiebolag' } as never,
  role: 'owner' as const,
  companies: [],
  isTeamMember: false,
  team: null,
  isSandbox: false,
  capabilities: [],
  assistantAvailable: false,
  trialEndsAt: null,
  entitlementState: 'active' as never,
  trialExpiredAt: null,
}


let installed = false

/** The demo company around a page, with the fixture API installed once. */
// The dashboard panel's classes (app/(dashboard)/layout.tsx MAIN_PANEL_CLASS), copied: that layout is a server module.
const MAIN_PANEL_CLASS =
  'safe-area-main-padding md:!pb-0 relative bg-background min-h-dvh ' +
  'md:min-h-0 md:ml-[var(--nav-w)] md:mt-[10px] md:mr-[var(--agent-dock-w)] md:h-[calc(100vh-20px)] ' +
  'md:overflow-y-auto md:rounded-xl md:border md:border-border'

// The real texts of packs, read from the repo by the item page on the server.
const PACK_TEXTS = new Map<string, string>()
export function providePackBody(id: string, body: string) {
  PACK_TEXTS.set(id, body)
}

export function SandboxShell({ children }: { children: ReactNode }) {
  useState(() => { if (typeof window !== 'undefined' && !installed) { installFixtures(); installed = true } })
  const [state] = useState(demoState)
  const company = {
    ...COMPANY,
    company: state.firm ? { id: 'demo-company', name: 'Exempelfirman', entity_type: 'enskild_firma' } : COMPANY.company,
    role: state.viewer ? 'viewer' as const : COMPANY.role,
  }
  return (
    <CompanyProvider value={company as never}>
      <AgentSheetProvider>
        {/* The dashboard's own frame (app/(dashboard)/layout.tsx): the real sidebar and the rounded panel, so the demo reads as the page will in the app. */}
        <div className="min-h-dvh bg-frame md:flex md:flex-col">
          <DashboardNav companyName={state.firm ? 'Exempelfirman' : 'Exempelbolaget AB'} entityType={state.firm ? 'enskild_firma' : 'aktiebolag'} agentsEnabled userName="Demo, inget sparas" />
          <main id="main-content" className={MAIN_PANEL_CLASS} role="main">
            <div className="px-4 pb-8 pt-4 md:px-6">
              {children}
            </div>
          </main>
        </div>
      </AgentSheetProvider>
    </CompanyProvider>
  )
}
