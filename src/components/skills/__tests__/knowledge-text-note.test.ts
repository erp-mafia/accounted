/**
 * The line above a knowledge item's text (KnowledgeItemView): that the text
 * is written for the AI and, for a general item, that it is in English. An
 * item the company wrote has no such line. The claim about the language is
 * checked against the texts themselves.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { stripFrontMatter } from '@/lib/agent-skills/front-matter'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { knowledgeTextNote } from '@/lib/agent-skills/knowledge-list'

// The item's text is not read here: the line stands above it whether or not it has arrived.
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined }) }))

const { KnowledgeItemView } = await import('../KnowledgeItemView')

const option = (id: string, tier: KnowledgeOption['tier'], title = id): KnowledgeOption => ({ id, tier, title, summary: `about ${id}`, version: 1, reviewed_at: null })
const GENERAL = option('horizontal/swedish-vat', 'horizontal')
const INDUSTRY = option('vertical/bygg-hantverk', 'vertical')
const FORM = option('modifier/holding-ab', 'modifier')
const OWN = option('own/22222222-2222-4222-8222-222222222222', 'own', 'Representation')

const render = (item: KnowledgeOption, locale: 'sv' | 'en' = 'sv') => renderInLocale(createElement(KnowledgeItemView, { option: item, companyId: 'company-a' }), locale)
const NOTES = [sv.skills_registry.ai_text_note_ai_english, sv.skills_registry.ai_text_note_ai, en.skills_registry.ai_text_note_ai_english, en.skills_registry.ai_text_note_ai]
/** The lines of the view that are one of the notes. */
const notes = (html: string) => visibleText(html).filter((line) => NOTES.includes(line))

describe('the line above a knowledge item\'s text', () => {
  it('says of a general item that it is written for the AI and is in English, in Swedish and in English', () => {
    expect(notes(render(GENERAL))).toEqual(['Skriven för din AI, på engelska.'])
    expect(notes(render(GENERAL, 'en'))).toEqual(['Written for your AI, in English.'])
  })

  it('stands between the heading of the text and the text, as one quiet line', () => {
    const html = render(GENERAL)
    const heading = html.indexOf(sv.skills_registry.ai_text_title)
    const note = html.indexOf(sv.skills_registry.ai_text_note_ai_english)
    const text = html.indexOf(sv.skills_registry.loading_short)
    expect(heading).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(heading)
    expect(text).toBeGreaterThan(note)
    expect(html).toContain(`<div class="text-xs text-muted-foreground">${sv.skills_registry.ai_text_note_ai_english}</div>`)
  })

  it('says of an industry or company-form item that it is written for the AI, and names no language', () => {
    for (const item of [INDUSTRY, FORM]) {
      expect(notes(render(item)), item.id).toEqual(['Skriven för din AI.'])
      expect(notes(render(item, 'en')), item.id).toEqual(['Written for your AI.'])
    }
  })

  it('is not there for an item the company wrote', () => {
    expect(notes(render(OWN))).toEqual([])
    expect(notes(render(OWN, 'en'))).toEqual([])
    // The rest of the view is: the name and the heading of the text.
    expect(visibleText(render(OWN))).toEqual(expect.arrayContaining(['Representation', sv.skills_registry.ai_text_title]))
  })

  it('is chosen by the tier alone', () => {
    expect(knowledgeTextNote('horizontal')).toBe('ai_english')
    expect(knowledgeTextNote('vertical')).toBe('ai')
    expect(knowledgeTextNote('modifier')).toBe('ai')
    expect(knowledgeTextNote('own')).toBeNull()
    expect(knowledgeTextNote('community')).toBeNull()
  })
})

describe('what the line says about the language, against the texts', () => {
  const ROOT = process.cwd()
  const manifest = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/.skill-body-manifest.json'), 'utf8')) as Record<string, unknown>)
  /** The top-level items of a tier, as the registry ids them. */
  const items = (tier: string) => manifest.filter((id) => id.startsWith(`${tier}/`) && id.split('/').length === 2)
  const DIR: Record<string, string> = { horizontal: '', vertical: 'industry/', modifier: 'modifier/' }
  const body = (id: string) => {
    const [tier, slug] = id.split('/')
    return stripFrontMatter(fs.readFileSync(path.join(ROOT, '.claude/skills', `${DIR[tier]}${slug}`, 'SKILL.md'), 'utf8'))
  }
  /** How many of the commonest words of each language a text holds. */
  const count = (text: string, words: string[]) => (text.toLowerCase().match(new RegExp(`(?<![\\p{L}])(?:${words.join('|')})(?![\\p{L}])`, 'gu')) ?? []).length
  const english = (text: string) => count(text, ['the', 'and', 'for', 'with', 'that', 'this', 'are', 'is'])
  const swedish = (text: string) => count(text, ['och', 'att', 'för', 'med', 'som', 'inte', 'eller', 'är'])

  it('holds for every general item: each text is written in English', () => {
    const general = items('horizontal')
    expect(general.length).toBeGreaterThan(10)
    for (const id of general) {
      const text = body(id)
      expect(english(text), id).toBeGreaterThan(3 * swedish(text))
    }
  })

  it('names no language for the industry and company-form items, which are written in Swedish or in English, item by item', () => {
    const rest = [...items('vertical'), ...items('modifier')]
    const inSwedish = rest.filter((id) => swedish(body(id)) > 3 * english(body(id)))
    const inEnglish = rest.filter((id) => english(body(id)) > 3 * swedish(body(id)))
    expect(inSwedish.length).toBeGreaterThan(0)
    expect(inEnglish.length).toBeGreaterThan(0)
  })
})
