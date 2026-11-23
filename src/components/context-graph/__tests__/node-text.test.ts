/**
 * The words of the context graph, with the real messages in both languages:
 * the legend names what people saved and the knowledge areas as the agent
 * picture's card names them, it is a plain key (a dot and a word per family,
 * no number), and a knowledge dot carries the name the knowledge folders
 * show for the same area.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GraphNode } from '@/lib/context-graph/types'

const locale = vi.hoisted(() => ({ current: 'sv' as 'sv' | 'en' }))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const messages = {
    sv: (await import('@/messages/sv.json')).default,
    en: (await import('@/messages/en.json')).default,
  }
  return {
    ...actual,
    // The translator the app gets, strict: a missing key or a broken ICU
    // message throws instead of rendering the key path.
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: locale.current,
        messages: messages[locale.current] as never,
        namespace: namespace as never,
        onError: (error) => {
          throw error
        },
      }),
    useLocale: () => locale.current,
  }
})

const { createTranslator } = await import('next-intl')
const { buildContextGraph, GRAPH_CAPS } = await import('@/lib/context-graph/build')
const { CHIP_FAMILIES } = await import('@/lib/context-graph/types')
const { knowledgeNameIn } = await import('@/components/skills/knowledge-labels')
const { describeNode, familyLabel, FAMILY_LABEL_KEY, nodeLabel } = await import('../node-text')
const { ContextGraph } = await import('../ContextGraph')

const MESSAGES = {
  sv: (await import('@/messages/sv.json')).default,
  en: (await import('@/messages/en.json')).default,
}

type Language = 'sv' | 'en'

const translator = (language: Language, namespace: string) =>
  createTranslator({
    locale: language,
    messages: MESSAGES[language] as never,
    namespace: namespace as never,
    onError: (error) => {
      throw error
    },
  })

/** The wiki translator, as the graph's text functions take it. */
const wiki = (language: Language) => translator(language, 'wiki') as unknown as Parameters<typeof describeNode>[1]

/** The name the knowledge folders show for an area: their own lookup, over the real messages. */
const folderName = (language: Language) => {
  const t = translator(language, 'skills_registry') as unknown as { (key: string): string; has: (key: string) => boolean }
  return (id: string, title: string) => knowledgeNameIn({ has: (key) => t.has(key), text: (key) => t(key) }, id, title)
}

const OWN_ID = 'own/7a000000-0000-4000-8000-000000000001'

/** A briefing with knowledge areas as the registry titles them, one of the company's own, facts and workflows. */
const BRIEFING = {
  atoms: [
    { atom_id: 'horizontal/swedish-vat', title: 'Swedish VAT', description: 'VAT rules.' },
    { atom_id: 'horizontal/swedish-accounting-compliance', title: 'Swedish Accounting Compliance', description: 'Bookkeeping rules.' },
    { atom_id: 'horizontal/swedish-year-end-closing', title: 'Swedish Year End Closing', description: 'Closing.' },
    { atom_id: 'horizontal/swedish-ef-skatteplanering', title: 'Swedish EF Skatteplanering', description: 'Sole trader tax.' },
    { atom_id: OWN_ID, title: 'Egna regler för utlägg', description: 'Written by the company.' },
  ],
  memory: [
    { fact_id: 'f1', kind: 'fact', content: 'Hyran betalas kvartalsvis.' },
    { fact_id: 'f2', kind: 'preference', content: 'Korta svar.' },
  ],
  group_memory: { group_name: 'Exempelbyrån', facts: [{ fact_id: 'g1', kind: 'fact', content: 'Månadsstängning senast den 10:e.' }] },
  data_status: { bank_last_synced_at: '2026-11-09T06:10:00Z' },
  suggestions: [{ title: 'Bankrader att bokföra som tidigare' }],
  recommended_tools: [{ workflow: 'categorize_month' }, { workflow: 'vat_declaration' }],
}

const model = buildContextGraph(BRIEFING)
const skill = (atomId: string): GraphNode => model.nodes.find((node) => node.id === `skill:${atomId}`)!
const text = (node: GraphNode, language: Language) =>
  describeNode(node, wiki(language), (date) => date, 0, undefined, folderName(language))

beforeEach(() => {
  locale.current = 'sv'
})

describe('the legend of the context graph', () => {
  it('names each family in Swedish and in English', () => {
    expect(CHIP_FAMILIES.map((family) => familyLabel(family, wiki('sv') as unknown as (key: string) => string))).toEqual(['Minne', 'Ur bokföringen', 'Väntar', 'Kunskap'])
    expect(CHIP_FAMILIES.map((family) => familyLabel(family, wiki('en') as unknown as (key: string) => string))).toEqual(['Memory', 'From the books', 'Waiting', 'Knowledge'])
  })

  it("reads the agent picture's own row names for what people saved and for the knowledge areas", () => {
    expect(FAMILY_LABEL_KEY.taught).toBe('picture.row_memory')
    expect(FAMILY_LABEL_KEY.instructions).toBe('picture.row_knowledge')
    for (const language of ['sv', 'en'] as const) {
      const t = wiki(language) as unknown as (key: string) => string
      expect(familyLabel('taught', t)).toBe(MESSAGES[language].wiki.picture.row_memory)
      expect(familyLabel('instructions', t)).toBe(MESSAGES[language].wiki.picture.row_knowledge)
      // The two have no message of their own in the graph: a second word has nowhere to live.
      expect(Object.keys(MESSAGES[language].wiki.graph.families).sort()).toEqual(['read', 'wait'])
      expect(MESSAGES[language].wiki).not.toHaveProperty('families')
    }
  })

  /** Each chip of the legend as the real component draws it: what is inside the button, and its text. */
  const chips = (language: Language, briefing: Record<string, unknown> = BRIEFING) => {
    locale.current = language
    const html = renderToStaticMarkup(createElement(ContextGraph, { text: JSON.stringify(briefing) }))
    return [...html.matchAll(/<button([^>]*aria-pressed[^>]*)>(.*?)<\/button>/g)].map((match) => ({
      attributes: match[1],
      inner: match[2],
      text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
  }

  it('draws each chip as its dot and its word, with no number', () => {
    expect(chips('sv').map((chip) => chip.text)).toEqual(['Minne', 'Ur bokföringen', 'Väntar', 'Kunskap'])
    expect(chips('en').map((chip) => chip.text)).toEqual(['Memory', 'From the books', 'Waiting', 'Knowledge'])
    for (const chip of chips('sv')) {
      // One element, the dot, then the word: nothing after it.
      expect(chip.inner, chip.text).toMatch(/^<span aria-hidden="true"[^>]*rounded-full[^>]*><\/span>[^<]+$/)
      expect(chip.text).not.toMatch(/\d/)
    }
  })

  it('reads the same however much the briefing holds', () => {
    const much = {
      ...BRIEFING,
      atoms: Array.from({ length: GRAPH_CAPS.skills + 5 }, (_, i) => ({ atom_id: `horizontal/area-${i}`, title: `Area ${i}` })),
      memory: Array.from({ length: GRAPH_CAPS.facts + 30 }, (_, i) => ({ fact_id: `f${i}`, kind: 'fact', content: `Fakta nummer ${i}.` })),
    }
    expect(chips('sv', much).map((chip) => chip.text)).toEqual(['Minne', 'Ur bokföringen', 'Väntar', 'Kunskap'])
    expect(chips('en', much).map((chip) => chip.text)).toEqual(['Memory', 'From the books', 'Waiting', 'Knowledge'])
  })

  it('has a chip for a family that holds something, and none for one that holds nothing', () => {
    expect(chips('sv', { atoms: BRIEFING.atoms }).map((chip) => chip.text)).toEqual(['Kunskap'])
    expect(chips('sv', { memory: BRIEFING.memory, suggestions: BRIEFING.suggestions }).map((chip) => chip.text)).toEqual(['Minne', 'Väntar'])
    // Which chips there are is read off the model's counts; the legend writes no number.
    expect(model.counts).toEqual({ taught: 3, read: 1, wait: 1, instructions: 6 })
  })

  it('keeps each chip a button that lights up its family: not pressed until someone presses it', () => {
    for (const chip of chips('sv')) {
      expect(chip.attributes, chip.text).toContain('type="button"')
      expect(chip.attributes, chip.text).toContain('aria-pressed="false"')
    }
  })
})

describe('the name of a knowledge dot', () => {
  it('is the name the knowledge folders show for the area, in Swedish', () => {
    const name = folderName('sv')
    expect(nodeLabel(skill('horizontal/swedish-vat'), wiki('sv'), name)).toBe('Moms')
    expect(nodeLabel(skill('horizontal/swedish-accounting-compliance'), wiki('sv'), name)).toBe('Bokföringslagen')
    expect(nodeLabel(skill('horizontal/swedish-year-end-closing'), wiki('sv'), name)).toBe('Bokslut')
    expect(text(skill('horizontal/swedish-vat'), 'sv').title).toBe('Moms')
    expect(text(skill('horizontal/swedish-accounting-compliance'), 'sv').title).toBe('Bokföringslagen')
  })

  it('is the name the knowledge folders show for the area, in English', () => {
    const name = folderName('en')
    expect(nodeLabel(skill('horizontal/swedish-vat'), wiki('en'), name)).toBe('VAT')
    expect(nodeLabel(skill('horizontal/swedish-accounting-compliance'), wiki('en'), name)).toBe('Bookkeeping Act')
    expect(nodeLabel(skill('horizontal/swedish-year-end-closing'), wiki('en'), name)).toBe('Year-end closing')
    expect(text(skill('horizontal/swedish-year-end-closing'), 'en').title).toBe('Year-end closing')
  })

  it('reads every area the folders name by the same lookup, in both languages', () => {
    for (const language of ['sv', 'en'] as const) {
      const names = MESSAGES[language].skills_registry.knowledge_names as Record<string, string>
      for (const [slug, shown] of Object.entries(names)) {
        const node: GraphNode = { id: `skill:horizontal/${slug}`, family: 'instructions', kind: 'skill', label: 'Registry Title', text: 'Registry Title', atomId: `horizontal/${slug}` }
        expect(text(node, language).title, `${language} ${slug}`).toBe(shown)
        expect(folderName(language)(`horizontal/${slug}`, 'Registry Title'), `${language} ${slug}`).toBe(shown)
      }
    }
  })

  it('cuts a long name under the dot at a word and keeps it whole in the panel', () => {
    const node = skill('horizontal/swedish-ef-skatteplanering')
    expect(nodeLabel(node, wiki('sv'), folderName('sv'))).toBe('Skatteplanering enskild…')
    expect(text(node, 'sv').title).toBe('Skatteplanering enskild firma')
  })

  it("keeps the company's own title for an area the folders have no name for", () => {
    expect(nodeLabel(skill(OWN_ID), wiki('sv'), folderName('sv'))).toBe('Egna regler för utlägg')
    expect(text(skill(OWN_ID), 'en').title).toBe('Egna regler för utlägg')
  })

  it("shows the briefing's own title where no lookup is given", () => {
    expect(nodeLabel(skill('horizontal/swedish-vat'), wiki('sv'))).toBe('Swedish VAT')
    expect(describeNode(skill('horizontal/swedish-vat'), wiki('sv'), (date) => date, 0).title).toBe('Swedish VAT')
  })

  it("carries the area's id on its dot as the briefing sent it, which the name is looked up by", () => {
    expect(skill('horizontal/swedish-vat').atomId).toBe('horizontal/swedish-vat')
    expect(skill(OWN_ID).atomId).toBe(OWN_ID)
  })
})
