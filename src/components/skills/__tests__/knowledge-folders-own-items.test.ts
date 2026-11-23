/**
 * The agent picture's Kunskap panel (KnowledgeFolders) and the company's own
 * items: the group under the folders, where each item opens, and the link to
 * the page that adds one. Rendered with the real messages in both languages.
 */
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInLocale } from '@/tests/i18n-render'
import { markupText, markupTexts } from '@/tests/markup-text'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import type { SkillSummary } from '../data'

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
const FLOW = '11111111-1111-4111-8111-111111111111'
const RULES = '22222222-2222-4222-8222-222222222222'
const ANALYSIS = '33333333-3333-4333-8333-333333333333'
const FIRM = '44444444-4444-4444-8444-444444444444'
const DRAFT = '55555555-5555-4555-8555-555555555555'

type Read<T> = { data?: T; error?: Error; mutate: () => Promise<void> }
const state = vi.hoisted(() => ({
  role: 'owner' as string,
  reads: {} as Record<string, { data?: unknown; error?: Error }>,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => createElement('a', { href, className }, children),
}))
vi.mock('@/contexts/CompanyContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/CompanyContext')>()),
  useCompany: () => ({ company: { id: COMPANY, name: 'Bolaget' }, role: state.role }),
}))
// Each read answers what the test gave its address: the panel's two reads are keyed by their route.
vi.mock('swr', () => ({
  default: (key: readonly string[] | null): Read<unknown> => ({ ...(key ? state.reads[key[0]] : {}), mutate: async () => {} }),
}))

const { KnowledgeFolders } = await import('../KnowledgeFolders')

const option = (id: string, tier: KnowledgeOption['tier'], title = id): KnowledgeOption => ({ id, tier, title, summary: `about ${id}`, version: 1, reviewed_at: null })
const OPTIONS = [option('horizontal/swedish-vat', 'horizontal'), option('modifier/holding-ab', 'modifier'), option(`own/${RULES}`, 'own', 'Representation')]

function own(id: string, name: string, over: Partial<SkillSummary> = {}, scope: 'company' | 'team' = 'company'): SkillSummary {
  return { slug: `own/${id}`, name, summary: `about ${name}`, tags: ['own'], tier: 'own', source: 'own', active: true, installations: [{ installation_id: id, scope }], ...over } as SkillSummary
}
const SHIPPED = [{ slug: 'horizontal/swedish-vat', name: 'Swedish VAT', summary: 'VAT', tags: [], tier: 'horizontal', source: 'accounted', active: true, installations: [] }] as unknown as SkillSummary[]

function render(catalog: { data?: SkillSummary[]; error?: Error } | null, locale: 'sv' | 'en' = 'sv'): string {
  state.reads = { '/api/agents/knowledge': { data: OPTIONS }, ...(catalog ? { '/api/skills': catalog } : {}) }
  return renderInLocale(createElement(KnowledgeFolders, { active: ['horizontal/swedish-vat'] }), locale)
}

/** Every link of the panel: where it leads and what it says. */
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], markupText(m[2], ' · ')])
/** The labelled groups of the panel, in order. */
const groups = (html: string) => [...html.matchAll(/<section aria-label="([^"]*)"/g)].map((m) => m[1])

const ADD = ['/skills/ny?typ=kunskap', sv.skills_registry.own_add]

beforeEach(() => {
  state.role = 'owner'
})

describe('the own items in the Kunskap panel', () => {
  it('has no own group for a company with no own items: the link to add one stands alone', () => {
    const html = render({ data: SHIPPED })
    expect(groups(html)).toEqual([sv.skills_registry.folders_general, sv.skills_registry.folders_also])
    expect(links(html)).toEqual([ADD])
  })

  it('lists an own flow, own knowledge and an own analysis under Egna, each a link to its own page, then the link to add one', () => {
    const html = render({ data: [...SHIPPED, own(FLOW, 'Påminn kunder', { itemKind: 'workflow' }), own(RULES, 'Representation', { itemKind: 'rules' }), own(ANALYSIS, 'Bruttomarginal', { itemKind: 'analysis' })] })
    expect(groups(html)).toEqual([sv.skills_registry.folders_general, sv.skills_registry.folders_also, sv.skills_registry.view_own])
    expect(links(html)).toEqual([
      [`/skills/egen.${ANALYSIS}`, 'Bruttomarginal · Analys'],
      [`/skills/own-${FLOW}`, 'Påminn kunder · Arbetsflöde'],
      [`/skills/egen.${RULES}`, 'Representation · Kunskap'],
      ADD,
    ])
  })

  it("lists the firm's items with the company's own, and says of each firm item that it is the firm's", () => {
    const html = render({ data: [own(FIRM, 'Månadsrutin', { itemKind: 'workflow' }, 'team'), own(RULES, 'Representation', { itemKind: 'rules' })] })
    expect(links(html).slice(0, 2)).toEqual([
      // The firm's item: the word for the firm, then its kind.
      [`/skills/own-${FIRM}`, 'Månadsrutin · Byråns · Arbetsflöde'],
      // The company's own item: its kind alone, as before.
      [`/skills/egen.${RULES}`, 'Representation · Kunskap'],
    ])
    expect(sv.skills_registry.own_firm).toBe('Byråns')
  })

  it("marks the firm's item of every kind, and a draft of the firm's, and no item of the company's", () => {
    const firm: SkillSummary[] = [
      own(FIRM, 'A flow', { itemKind: 'workflow' }, 'team'),
      own(RULES, 'B knowledge', { itemKind: 'rules' }, 'team'),
      own(ANALYSIS, 'C analysis', { itemKind: 'analysis' }, 'team'),
      own(DRAFT, 'D draft', { itemKind: 'analysis', draft: true, active: false }, 'team'),
    ]
    // The markup writes an apostrophe as an entity: read it back as the reader sees it.
    const notes = (catalog: SkillSummary[], locale: 'sv' | 'en'): string[] =>
      links(render({ data: catalog }, locale)).slice(0, catalog.length).map(([, text]) => text.replaceAll('&#x27;', "'"))
    // A draft comes first: it waits for a person.
    expect(notes(firm, 'sv')).toEqual([`D draft · Byråns · ${sv.skills_registry.draft_tag}`, 'A flow · Byråns · Arbetsflöde', 'B knowledge · Byråns · Kunskap', 'C analysis · Byråns · Analys'])
    expect(notes(firm, 'en')).toEqual([`D draft · The firm's · ${en.skills_registry.draft_tag}`, "A flow · The firm's · Workflow", "B knowledge · The firm's · Knowledge", "C analysis · The firm's · Analysis"])
    const company: SkillSummary[] = firm.map((item): SkillSummary => ({ ...item, installations: [{ installation_id: item.installations[0].installation_id, scope: 'company' }] }))
    expect(notes(company, 'sv').filter((text) => text.includes(sv.skills_registry.own_firm))).toEqual([])
    expect(notes(company, 'en').filter((text) => text.includes(en.skills_registry.own_firm))).toEqual([])
  })

  it('says of a draft an AI saved that it waits to be added, as the catalogue does', () => {
    const html = render({ data: [own(DRAFT, 'Kassaflöde', { itemKind: 'analysis', draft: true, active: false })] })
    expect(links(html)[0]).toEqual([`/skills/egen.${DRAFT}`, `Kassaflöde · ${sv.skills_registry.draft_tag}`])
  })

  it('keeps the own knowledge item out of the folders: it is listed once, under Egna', () => {
    const html = render({ data: [own(RULES, 'Representation', { itemKind: 'rules' })] })
    // The folders are buttons that open in place; the own item is a link.
    const buttons = [...html.matchAll(/<button[^>]*title="[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => markupText(m[1]))
    expect(buttons).toEqual(['Moms', 'Holdingbolag'])
    expect(html.match(/Representation/g)).toHaveLength(1)
  })

  it('masks what a person typed in recordings, and puts its one line in no attribute', () => {
    const html = render({ data: [own(RULES, 'Representation', { itemKind: 'rules' })] })
    expect(html).toMatch(/<span[^>]*data-ph-mask=""[^>]*>Representation<\/span>/)
    expect(html).not.toContain('about Representation')
  })

  it('reads in English for an English reader', () => {
    const html = render({ data: [own(FLOW, 'Påminn kunder', { itemKind: 'workflow' })] }, 'en')
    expect(groups(html)).toContain(en.skills_registry.view_own)
    expect(links(html)).toEqual([
      [`/skills/own-${FLOW}`, 'Påminn kunder · Workflow'],
      ['/skills/ny?typ=kunskap', en.skills_registry.own_add],
    ])
  })
})

describe('the link to add an own item', () => {
  it('opens the existing page that adds one, on knowledge', () => {
    expect(links(render({ data: [] }))).toEqual([ADD])
    expect(sv.skills_registry.own_add).toBe('Lägg till egen kunskap, ett arbetsflöde eller en analys')
    expect(en.skills_registry.own_add).toBe('Add knowledge, a workflow or an analysis of your own')
  })

  it('is not shown to a person who cannot write: the own items still are', () => {
    state.role = 'viewer'
    expect(links(render({ data: [] }))).toEqual([])
    expect(links(render({ data: [own(RULES, 'Representation', { itemKind: 'rules' })] }))).toEqual([[`/skills/egen.${RULES}`, 'Representation · Kunskap']])
  })

  it('waits for the own items to be read: nothing is said about them before', () => {
    const html = render(null)
    expect(links(html)).toEqual([])
    expect(groups(html)).toEqual([sv.skills_registry.folders_general, sv.skills_registry.folders_also])
  })

  it('stays when the own items could not be read, under a line that says so with a retry', () => {
    const html = render({ error: new Error('Skills request failed') })
    expect(groups(html)).toContain(sv.skills_registry.view_own)
    const text = markupTexts(html)
    expect(text).toContain(sv.skills_registry.load_failed)
    expect(text).toContain(sv.skills_registry.retry)
    expect(links(html)).toEqual([ADD])
  })
})
