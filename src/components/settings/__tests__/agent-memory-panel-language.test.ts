/**
 * The memory panel in the reader's language. Its texts are read from the
 * message files, so an English reader meets no Swedish, and a Swedish reader
 * meets the words the panel has always had.
 *
 * AgentMemoryView is the panel drawn from its state, with no request of its
 * own: each state a person can meet (the list, the add form, a row being
 * edited, hidden rows, no memories, a failed read) is rendered under both
 * catalogues and read as a browser would get it: text, placeholder, title
 * and aria-label. The help behind the "?" renders inline here.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'

type Children = { children?: ReactNode }

// A closed popover and a closed select keep their content out of a server
// render: the stubs put the help text and the kinds to choose from in the HTML.
vi.mock('@/components/ui/help-popover', () => ({
  HelpPopover: ({ children }: Children) => createElement('div', null, children),
}))
vi.mock('@/components/ui/select', () => {
  const pass = ({ children }: Children) => createElement('div', null, children)
  return {
    Select: pass,
    SelectTrigger: ({ children, 'aria-label': label }: Children & { 'aria-label'?: string }) => createElement('div', { 'aria-label': label }, children),
    SelectContent: pass,
    SelectGroup: pass,
    SelectLabel: pass,
    SelectValue: () => null,
    SelectItem: pass,
  }
})

import { AgentMemoryView, type AgentMemoryRow, type AgentMemoryState } from '../AgentMemoryPanel'

/** The words the panel had written into it, as the Swedish reader still meets them. */
const SWEDISH_WORDS: readonly string[] = [
  'Visa dolda',
  'Dölj dolda',
  'Lägg till minne',
  'Nytt minne',
  'T.ex.',
  'Typ',
  'Fakta',
  'Preferens',
  'Preferenser',
  'Mönster',
  'Korrigering',
  'Korrigeringar',
  'Alla',
  'Avbryt',
  'Spara',
  'Redigera',
  'Redigera minne',
  'Dölj',
  'Återställ',
  'Fäst',
  'Lossa',
  'aktiva',
  'fästa',
  'dolda',
  'dold',
  'Filtrera minnen',
  'Bokföringsassistenten',
  'Inga minnen ännu',
  'dyker de upp här',
  'Minnena kunde inte läsas in just nu.',
  'Försök igen',
  'Kunde inte uppdatera',
  'Kunde inte spara minne',
  'Minne sparat',
]

/** Whether `text` holds `word` as a word or phrase of its own ("Typ", not the "Typ" in "Type"). */
function holds(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

const row = (id: string, over: Partial<AgentMemoryRow> = {}): AgentMemoryRow => ({
  id,
  kind: 'fact',
  content: `Note ${id}`,
  source: 'user_taught',
  source_ref: null,
  relevance_score: 1,
  is_pinned: false,
  is_active: true,
  last_accessed_at: null,
  created_at: '2026-03-02T09:00:00.000Z',
  updated_at: '2026-03-02T09:00:00.000Z',
  created_by: { name: 'Anna Ek', deleted: false },
  client: null,
  answered_question: null,
  ...over,
})

const ROWS: AgentMemoryRow[] = [
  row('fact'),
  row('pinned', { kind: 'preference', is_pinned: true }),
  row('pattern', { kind: 'pattern', source: 'agent_learned', client: 'claude' }),
  row('correction', { kind: 'correction', created_by: { name: null, deleted: true } }),
  row('composer', { source: 'composer', created_by: null }),
  row('hidden', { is_active: false }),
]

function state(over: Partial<AgentMemoryState> = {}): AgentMemoryState {
  const base: AgentMemoryState = {
    canWrite: true,
    errorLocale: 'en',
    rows: ROWS,
    loadError: null,
    retry: () => {},
    includeDismissed: false,
    setIncludeDismissed: () => {},
    kindFilter: 'all',
    setKindFilter: () => {},
    busyId: null,
    editingId: null,
    setEditingId: () => {},
    editDraft: '',
    setEditDraft: () => {},
    showAdd: false,
    setShowAdd: () => {},
    newContent: '',
    setNewContent: () => {},
    newKind: 'fact',
    setNewKind: () => {},
    adding: false,
    patch: async () => {},
    addMemory: async () => {},
    startEdit: () => {},
    saveEdit: async () => {},
  }
  return { ...base, ...over }
}

interface Shown {
  name: string
  plain: boolean
  memory: Partial<AgentMemoryState>
}

/** Every state of the panel a person can meet, in both of its variants. */
const STATES: Shown[] = [
  { name: 'the list', plain: false, memory: {} },
  { name: 'the list with the hidden rows shown', plain: false, memory: { includeDismissed: true } },
  { name: 'the add form', plain: false, memory: { showAdd: true } },
  { name: 'a row being edited', plain: false, memory: { editingId: 'fact', editDraft: 'Note fact' } },
  { name: 'no memories', plain: false, memory: { rows: [] } },
  { name: 'the list while it is read', plain: false, memory: { rows: null } },
  { name: 'a read that failed', plain: false, memory: { rows: null, loadError: { detail: null } } },
  { name: 'a read that failed with something to do', plain: false, memory: { rows: null, loadError: { detail: 'Sign in again.' } } },
  { name: 'the list for a reader who cannot write', plain: false, memory: { canWrite: false } },
  { name: 'the plain list', plain: true, memory: {} },
  { name: 'the plain list with the hidden rows shown and the add form', plain: true, memory: { includeDismissed: true, showAdd: true } },
  { name: 'the plain list with no memories', plain: true, memory: { rows: [] } },
]

function texts(shown: Shown, locale: 'sv' | 'en'): string[] {
  const memory = state({ errorLocale: locale, ...shown.memory })
  return visibleText(renderInLocale(createElement(AgentMemoryView, { plain: shown.plain, memory }), locale))
}

describe('the memory panel for an English reader', () => {
  it.each(STATES)('shows no Swedish in $name', (shown) => {
    const english = texts(shown, 'en')
    expect(english.filter(looksSwedish)).toEqual([])
    const found: string[] = SWEDISH_WORDS.filter((word) => english.some((text) => holds(text, word)))
    expect(found).toEqual([])
  })

  it('says each thing in English', () => {
    const all: string[] = STATES.flatMap((shown) => texts(shown, 'en'))
    for (const text of [
      'Show hidden',
      'Hide hidden',
      'Add memory',
      'New memory',
      'E.g. We use Stripe for B2C payments; payouts land on 1930 every Monday.',
      'Type',
      'Fact',
      'Preference',
      'Pattern',
      'Correction',
      'Cancel',
      'Save',
      'Edit',
      'Edit memory',
      'Hide',
      'Restore',
      'Pin',
      'Unpin',
      'Pin: the memory is always sent along',
      '5 active · 1 pinned',
      '5 active · 1 pinned · 1 hidden',
      'Filter memories',
      'All',
      'Facts',
      'Preferences',
      'Patterns',
      'Corrections',
      'The bookkeeping assistant uses these notes to give you the right advice. Pin what should always be included, edit what is wrong, or hide what no longer holds. Up to 30 memories are included in a conversation per turn.',
      'No memories yet',
      'When you teach the assistant things (or when it notes things itself with your approval), they show up here.',
      'The memories could not be loaded right now.',
      'The memories could not be loaded right now. Sign in again.',
      'Try again',
    ]) {
      expect(all, text).toContain(text)
    }
  })

  it('says the toasts in English too', () => {
    const toasts: string[] = [en.settings.memory_update_failed, en.settings.memory_save_failed, en.settings.memory_saved]
    expect(toasts).toEqual(['Could not update', 'Could not save the memory', 'Memory saved'])
    expect(toasts.filter(looksSwedish)).toEqual([])
  })
})

describe('the memory panel for a Swedish reader', () => {
  it('keeps every word it had', () => {
    const all: string[] = STATES.flatMap((shown) => texts(shown, 'sv'))
    for (const text of [
      'Visa dolda',
      'Dölj dolda',
      'Lägg till minne',
      'Nytt minne',
      'T.ex. Vi använder Stripe för B2C-betalningar; utbetalningar landar på 1930 var måndag.',
      'Typ',
      'Fakta',
      'Preferens',
      'Mönster',
      'Korrigering',
      'Avbryt',
      'Spara',
      'Redigera',
      'Redigera minne',
      'Dölj',
      'Återställ',
      'Fäst',
      'Lossa',
      'Fäst: minnet skickas alltid med',
      '5 aktiva · 1 fästa',
      '5 aktiva · 1 fästa · 1 dolda',
      'Filtrera minnen',
      'Alla',
      'Preferenser',
      'Korrigeringar',
      'Bokföringsassistenten använder dessa anteckningar för att ge dig rätt råd. Fäst det som alltid ska vara med, redigera fel, eller dölj det som inte längre stämmer. Upp till 30 minnen ingår i samtal per tur.',
      'Inga minnen ännu',
      'När du lär assistenten saker (eller när den noterar saker själv med ditt godkännande) dyker de upp här.',
      'Minnena kunde inte läsas in just nu.',
      'Minnena kunde inte läsas in just nu. Sign in again.',
      'Försök igen',
    ]) {
      expect(all, text).toContain(text)
    }
    const toasts: string[] = [sv.settings.memory_update_failed, sv.settings.memory_save_failed, sv.settings.memory_saved]
    expect(toasts).toEqual(['Kunde inte uppdatera', 'Kunde inte spara minne', 'Minne sparat'])
  })
})

describe("the company card's memory line", () => {
  /** A translator read by a plain key, as the card reads its line. */
  type Line = (key: string, values: Record<string, number>) => string
  const wikiSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'wiki' }) as unknown as Line
  const wikiEn = createTranslator({ locale: 'en', messages: en, namespace: 'wiki' }) as unknown as Line

  it('says in English who was told, as a whole sentence', () => {
    expect(wikiEn('picture.memory_line', { count: 0 })).toBe('Nothing saved yet')
    expect(wikiEn('picture.memory_line', { count: 1 })).toBe('1 thing you have told the agent')
    expect(wikiEn('picture.memory_line', { count: 12 })).toBe('12 things you have told the agent')
  })

  it('reads in Swedish as before', () => {
    expect(wikiSv('picture.memory_line', { count: 0 })).toBe('Inget sparat än')
    expect(wikiSv('picture.memory_line', { count: 1 })).toBe('1 sak ni har berättat')
    expect(wikiSv('picture.memory_line', { count: 12 })).toBe('12 saker ni har berättat')
  })
})
