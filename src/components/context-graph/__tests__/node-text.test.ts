/**
 * The words of the context graph, with the real messages in both languages:
 * the legend names what people saved and the knowledge areas as the agent
 * picture's card names them, it is a plain key (a dot and a word per family,
 * no number), a knowledge dot carries the name and the one line the
 * knowledge folders show for the same area, under the picture's own word for
 * it, and an account dot carries the account's name after its number.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GraphNode } from '@/lib/context-graph/types'
import { markupText } from '@/tests/markup-text'

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
const { knowledgeDescIn, knowledgeNameIn } = await import('@/components/skills/knowledge-labels')
const { describeNode, familyLabel, FAMILY_LABEL_KEY, nodeLabel, nodeName } = await import('../node-text')
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

/** The skills_registry messages, as the folders' lookups read them. */
const folderMessages = (language: Language) => {
  const t = translator(language, 'skills_registry') as unknown as { (key: string): string; has: (key: string) => boolean }
  return { has: (key: string) => t.has(key), text: (key: string) => t(key) }
}

/** The name the knowledge folders show for an area: their own lookup, over the real messages. */
const folderName = (language: Language) => (id: string, title: string) => knowledgeNameIn(folderMessages(language), id, title)

/** The one line the knowledge folders show for an area: their own lookup, over the real messages. */
const folderDesc = (language: Language) => (id: string, description: string) => knowledgeDescIn(folderMessages(language), id, description)

/** The folders' two lookups, as the graph is handed them. */
const folders = (language: Language) => ({ knowledgeName: folderName(language), knowledgeDesc: folderDesc(language) })

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
const text = (node: GraphNode, language: Language) => describeNode(node, wiki(language), (date) => date, 0, undefined, folders(language))

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
      text: markupText(match[2]),
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
    expect(nodeLabel(skill('horizontal/swedish-vat'), wiki('sv'), { knowledgeName: name })).toBe('Moms')
    expect(nodeLabel(skill('horizontal/swedish-accounting-compliance'), wiki('sv'), { knowledgeName: name })).toBe('Bokföringslagen')
    expect(nodeLabel(skill('horizontal/swedish-year-end-closing'), wiki('sv'), { knowledgeName: name })).toBe('Bokslut')
    expect(text(skill('horizontal/swedish-vat'), 'sv').title).toBe('Moms')
    expect(text(skill('horizontal/swedish-accounting-compliance'), 'sv').title).toBe('Bokföringslagen')
  })

  it('is the name the knowledge folders show for the area, in English', () => {
    const name = folderName('en')
    expect(nodeLabel(skill('horizontal/swedish-vat'), wiki('en'), { knowledgeName: name })).toBe('VAT')
    expect(nodeLabel(skill('horizontal/swedish-accounting-compliance'), wiki('en'), { knowledgeName: name })).toBe('Bookkeeping Act')
    expect(nodeLabel(skill('horizontal/swedish-year-end-closing'), wiki('en'), { knowledgeName: name })).toBe('Year-end closing')
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
    expect(nodeLabel(node, wiki('sv'), folders('sv'))).toBe('Skatteplanering enskild…')
    expect(text(node, 'sv').title).toBe('Skatteplanering enskild firma')
  })

  it("keeps the company's own title for an area the folders have no name for", () => {
    expect(nodeLabel(skill(OWN_ID), wiki('sv'), folders('sv'))).toBe('Egna regler för utlägg')
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

describe('the panel of a knowledge dot', () => {
  it("says what it is with the agent picture's own word, in both languages", () => {
    expect(text(skill('horizontal/swedish-vat'), 'sv').kind).toBe('Kunskap')
    expect(text(skill('horizontal/swedish-vat'), 'en').kind).toBe('Knowledge')
    for (const language of ['sv', 'en'] as const) {
      expect(text(skill('horizontal/swedish-vat'), language).kind).toBe(MESSAGES[language].wiki.picture.row_knowledge)
      // The word has no message of its own in the graph: a second word has nowhere to live.
      expect(MESSAGES[language].wiki.graph.kinds).not.toHaveProperty('skill')
    }
  })

  it('shows the name and the one line the knowledge folders show for the area, in Swedish', () => {
    const shown = text(skill('horizontal/swedish-vat'), 'sv')
    expect(shown.title).toBe('Moms')
    expect(shown.meta).toEqual([MESSAGES.sv.skills_registry.knowledge_descs['swedish-vat']])
    // Not the registry's own description, which is written in English for agent routing.
    expect(shown.meta).not.toContain('VAT rules.')
    expect(text(skill('horizontal/swedish-ef-skatteplanering'), 'sv')).toMatchObject({
      kind: 'Kunskap',
      title: 'Skatteplanering enskild firma',
      meta: ['Egenavgifter, räntefördelning och periodiseringsfond för enskild firma.'],
    })
  })

  it('shows them in English for an English reader', () => {
    const shown = text(skill('horizontal/swedish-vat'), 'en')
    expect(shown.title).toBe('VAT')
    expect(shown.meta).toEqual([MESSAGES.en.skills_registry.knowledge_descs['swedish-vat']])
    expect(text(skill('horizontal/swedish-year-end-closing'), 'en')).toMatchObject({
      kind: 'Knowledge',
      title: 'Year-end closing',
      meta: [MESSAGES.en.skills_registry.knowledge_descs['swedish-year-end-closing']],
    })
  })

  it('reads every area the folders describe by the same lookup, in both languages', () => {
    for (const language of ['sv', 'en'] as const) {
      const lines = MESSAGES[language].skills_registry.knowledge_descs as Record<string, string>
      for (const [slug, shown] of Object.entries(lines)) {
        const node: GraphNode = { id: `skill:horizontal/${slug}`, family: 'instructions', kind: 'skill', label: 'Registry Title', text: 'Registry Title', detail: 'Registry description.', atomId: `horizontal/${slug}` }
        expect(text(node, language).meta, `${language} ${slug}`).toEqual([shown])
        expect(folderDesc(language)(`horizontal/${slug}`, 'Registry description.'), `${language} ${slug}`).toBe(shown)
      }
    }
  })

  it("keeps the company's own line for an area the folders have no line for", () => {
    for (const language of ['sv', 'en'] as const) {
      expect(text(skill(OWN_ID), language)).toMatchObject({ kind: MESSAGES[language].wiki.picture.row_knowledge, title: 'Egna regler för utlägg', meta: ['Written by the company.'] })
    }
  })

  it("shows the briefing's own description where no lookup is given, and no line where it sends none", () => {
    expect(describeNode(skill('horizontal/swedish-vat'), wiki('sv'), (date) => date, 0).meta).toEqual(['VAT rules.'])
    const bare: GraphNode = { id: 'skill:horizontal/unnamed', family: 'instructions', kind: 'skill', label: 'Unnamed', text: 'Unnamed', atomId: 'horizontal/unnamed' }
    expect(text(bare, 'sv').meta).toEqual([])
  })

  it('names the dot and the "+N" dot of its kind with the same word', () => {
    const node = skill('horizontal/swedish-vat')
    expect(nodeName(node, text(node, 'sv'), wiki('sv'))).toBe('Kunskap: Moms')
    expect(nodeName(node, text(node, 'en'), wiki('en'))).toBe('Knowledge: VAT')
    const more: GraphNode = { id: 'more:skill', family: 'instructions', kind: 'more', label: null, text: null, count: 5, moreOf: 'skill' }
    expect(text(more, 'sv').kind).toBe('Kunskap')
    expect(text(more, 'en').kind).toBe('Knowledge')
  })

  it('leaves the panel of every other kind of dot as it was', () => {
    const kinds = { fact: 'Företagets minne', group_fact: 'Gruppens minne', bank: 'Banken', suggestion: 'Förslag', workflows: 'Arbetsflöden' }
    for (const [kind, word] of Object.entries(kinds)) {
      const node = model.nodes.find((n) => n.kind === kind)!
      expect(text(node, 'sv').kind, kind).toBe(word)
      expect(text(node, 'sv'), kind).toEqual(describeNode(node, wiki('sv'), (date) => date, 0))
    }
  })
})

describe('an account dot', () => {
  /** A briefing whose counterparties are booked on three accounts, and a check on a fourth. */
  const LEDGER = {
    ledger_context: {
      top_supplier_patterns: [
        { supplier: 'Telia Sverige AB', dominant_account_number: '6212', evidence: { seen_12m: 12, agree: 12, last_booked: '2026-06-28' } },
        { supplier: 'Fastighets AB Exempel', dominant_account_number: '5010', evidence: { seen_12m: 4, agree: 4, last_booked: '2026-06-01' } },
      ],
      top_counterparty_patterns: [{ counterparty: 'Okänd Motpart', dominant_account_number: '6999', evidence: { seen_12m: 2, agree: 2, last_booked: '2026-05-01' } }],
    },
    unexplained: { as_of: '2026-07-01', top: [{ check_id: 'bank_balance', name_sv: 'Banksaldot stämmer inte', subject: '1930', difference: 120, unit: 'SEK' }] },
  }
  const ledger = buildContextGraph(LEDGER)
  const account = (number: string): GraphNode => ledger.nodes.find((node) => node.id === `account:${number}`)!
  /** The company's chart, as the graph's host hands it in: one lookup by number. */
  const CHART: Record<string, string> = { '1930': 'Företagskonto', '5010': 'Lokalhyra', '6212': 'Mobiltelefon och bredband för kontoret' }
  const chart = { accountName: (number: string) => CHART[number] }
  const panel = (node: GraphNode, language: Language, lookups = chart) => describeNode(node, wiki(language), (date) => date, 1, undefined, lookups)

  it('shows the number and the name of the account under the dot', () => {
    expect(nodeLabel(account('1930'), wiki('sv'), chart)).toBe('1930 Företagskonto')
    expect(nodeLabel(account('5010'), wiki('en'), chart)).toBe('5010 Lokalhyra')
  })

  it('cuts a long name at a word under the dot and keeps it whole in the panel', () => {
    expect(nodeLabel(account('6212'), wiki('sv'), chart)).toBe('6212 Mobiltelefon och…')
    expect(panel(account('6212'), 'sv').title).toBe('Konto 6212 Mobiltelefon och bredband för kontoret')
  })

  it('says the number and the name in the panel, in both languages', () => {
    expect(panel(account('1930'), 'sv')).toMatchObject({ kind: 'Konto', title: 'Konto 1930 Företagskonto' })
    expect(panel(account('1930'), 'en')).toMatchObject({ kind: 'Account', title: 'Account 1930 Företagskonto' })
    // The line about what is booked there is as before.
    expect(panel(account('5010'), 'sv').meta).toEqual(['1 motpart bokförs här'])
  })

  it('shows the number alone for an account the chart does not hold, and before the chart is read', () => {
    expect(nodeLabel(account('6999'), wiki('sv'), chart)).toBe('6999')
    expect(panel(account('6999'), 'sv').title).toBe('Konto 6999')
    expect(nodeLabel(account('1930'), wiki('sv'))).toBe('1930')
    expect(nodeLabel(account('1930'), wiki('sv'), {})).toBe('1930')
    expect(describeNode(account('1930'), wiki('sv'), (date) => date, 0).title).toBe('Konto 1930')
    expect(nodeLabel(account('1930'), wiki('sv'), { accountName: () => '  ' })).toBe('1930')
  })

  it('leaves every other dot as it is: a counterparty and a check still name the account by its number', () => {
    const counterparty = ledger.nodes.find((node) => node.kind === 'counterparty' && node.account === '6212')!
    expect(nodeLabel(counterparty, wiki('sv'), chart)).toBe('Telia')
    expect(panel(counterparty, 'sv').title).toBe('Telia Sverige AB bokförs på 6212')
    const check = ledger.nodes.find((node) => node.kind === 'check')!
    expect(panel(check, 'sv')).toEqual(describeNode(check, wiki('sv'), (date) => date, 1))
    expect(panel(check, 'sv').meta[0]).toContain('1930')
  })

  it('carries no name in the model: the briefing sends the number, and the host hands the names in from one read of the chart', () => {
    expect(account('1930')).toEqual({ id: 'account:1930', family: 'ref', kind: 'account', label: '1930', text: null, account: '1930' })
    const host = fs.readFileSync(path.resolve(__dirname, '../ContextGraph.tsx'), 'utf8')
    // The shared accounts read, once for the whole graph, and nothing fetched beside it.
    expect(host.match(/useAccounts\(/g)).toHaveLength(1)
    expect(host).toContain('const { accounts } = useAccounts(false)')
    expect(host).not.toMatch(/\bfetch\(|useSWR/)
    expect(host).toContain('nodeLabel(n, t, lookups)')
    expect(host).toContain('counterparties, pages, lookups)')
  })
})
