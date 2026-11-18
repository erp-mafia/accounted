import type { AiToolDef } from '@/lib/ai'
import { resolveNavPlace } from '@/components/dashboard/nav-v3'
import { menuTrail, type UiMapInput } from '@/lib/agent/ask/ui-map'
import type { Locale } from '@/i18n/config'
import type { MessageTree, PageTextIndex } from './page-text-index'
import { examplePath, matchRoute, pageParts, renderPageTexts, searchAppTexts, withRole } from './page-texts'

/**
 * The support assistant's own tools, beside the read-only ledger tools
 * (lib/agent/ask/ledger-tools.ts):
 *
 *   read_page           the texts on one page of the app
 *   find_in_app         where in the app a word is used
 *   offer_human_support  put the "send to a person" button under the answer
 *
 * None of them writes anything. The first two answer only for pages this
 * company has: the same gates as the menu the assistant is given.
 */

export const HANDOFF_REASONS = ['cannot_answer', 'problem_report', 'account_or_billing', 'asked_for_human'] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

/** The assistant's own word that a person should take over, with its summary for the ticket. */
export interface HandoffOffer {
  reason: HandoffReason
  summary: string
}

export interface AppToolsInput {
  index: PageTextIndex
  messages: MessageTree
  locale: Locale
  /** The gated menu of this company: the same input the menu map is rendered from. */
  ui: UiMapInput
  /** Called when the assistant offers a person; the caller shows the button and keeps the record. */
  onHandoff: (offer: HandoffOffer) => void
}

/**
 * Whether this company has the page: it is in its menu, or it is a page the
 * menu lists for nobody (Hjälp, which the user menu leads to). A page under a
 * row of the full menu that this company's menu does not have is a page it
 * does not have (Lön without salaries, a lönekörning's own page included),
 * and the assistant must not describe it; the same goes for a settings page
 * outside the sections the company sees.
 */
export function isPageVisible(pattern: string, ui: UiMapInput): boolean {
  const path = examplePath(pattern)
  if (menuTrail(path, ui) !== null) return true
  if (path === '/settings' || path.startsWith('/settings/')) return false
  return resolveNavPlace(path, '')?.href == null
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function buildAppTools(input: AppToolsInput): AiToolDef[] {
  const { index, messages, locale, ui } = input
  const visible = new Map<string, boolean>()
  const isVisible = (pattern: string): boolean => {
    const known = visible.get(pattern)
    if (known !== undefined) return known
    const answer = isPageVisible(pattern, ui)
    visible.set(pattern, answer)
    return answer
  }
  const trailOf = (pattern: string): string => {
    const trail = menuTrail(examplePath(pattern), ui)
    return trail ? `${trail.join(' → ')} (${pattern})` : pattern
  }

  const readPage: AiToolDef = {
    name: 'read_page',
    description:
      'Read what is written on one page of the app: its labels, buttons, tabs, field names and help texts, exactly as the user sees them, grouped by the part of the page they belong to (the page itself, then each dialog or component it renders). A text is followed by what it is in parentheses where that is known: (knapp) button, (flik) tab, (rubrik) heading, (fält) field label, (kolumn) column, (menyval) menu item, (val) option, (länk) link, (platshållare) placeholder, (hjälptext) help text, (status) status. A text with nothing after it has no known role: never call it a button, a tab or anything else. Call this before you describe what is on a page or how something is done there. It does not say where on the page a text sits or in which state it is shown. A long page is cut: pass `part` to read one named part, or `search` to get only the texts that contain a word (a role word such as "flik" gets every text of that role).',
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The page path, as given in the menu or as the page the user is on, e.g. "/invoices" or "/settings/company".',
        },
        part: { type: 'string', description: 'Optional: read only this part, by the name in square brackets from an earlier call.' },
        search: { type: 'string', description: 'Optional: only texts that contain every word given here.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = text(args.path, 300)
      if (!path.startsWith('/')) return { error: 'path must start with a slash, e.g. "/invoices".' }
      const pattern = matchRoute(index, path)
      if (!pattern) return { error: `No page texts for ${path}. Use a path from the menu, or find_in_app.` }
      if (!isVisible(pattern)) return { error: `The page ${path} is not part of this company's app.` }
      const parts = pageParts(index, pattern, messages, locale)
      return {
        page: trailOf(pattern),
        texts: renderPageTexts(parts, { part: text(args.part, 120) || undefined, search: text(args.search, 120) || undefined }),
      }
    },
  }

  const findInApp: AiToolDef = {
    name: 'find_in_app',
    description:
      'Find where in the app a word or phrase is used: searches the labels, buttons and help texts of every page this company has and answers with the matching texts and the pages they are on. Use it when the menu does not tell you which page something is done on. Search for words the user would see on screen, one or two at a time, in the language of the app; try another word when the first finds nothing.',
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One or a few words; a text matches when it contains all of them.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = text(args.query, 120)
      if (query.length < 2) return { error: 'query is too short.' }
      const hits = searchAppTexts(index, messages, query, isVisible, { locale })
      if (hits.length === 0) return { matches: [], note: `No text in the app contains "${query}".` }
      return {
        matches: hits.map((hit) => ({
          text: withRole(hit),
          on: hit.places.map((place) => `${trailOf(place.route)} [${place.part}]`),
        })),
      }
    },
  }

  return [readPage, findInApp, handoffTool(input.onHandoff)]
}

/** The one tool the assistant has even without page texts: saying that a person should take over. */
export function handoffTool(onHandoff: (offer: HandoffOffer) => void): AiToolDef {
  return {
    name: 'offer_human_support',
    description:
      'Show the user a button that sends this conversation to Accounted\'s support staff. Call it when you cannot answer from the menu, the page texts or the ledger tools; when something looks like a fault in the app; when the matter is one only Accounted can handle (the account, the subscription, payments to Accounted, a data correction); or when the user asks for a person. Then write your answer as usual and say that the question can be sent on with the button below the answer.',
    jsonSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: [...HANDOFF_REASONS] },
        summary: {
          type: 'string',
          description: 'One or two sentences for the support staff: what the user wants and what you could not answer or do.',
        },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const reason = HANDOFF_REASONS.find((r) => r === args.reason) ?? 'cannot_answer'
      onHandoff({ reason, summary: text(args.summary, 600) })
      return { shown: true }
    },
  }
}
