/**
 * The wiki's views and their addresses (src/components/wiki/WikiViews.tsx):
 * Kontext (what the agent receives, the landing), Karta (the konteringskarta
 * and ledger profile, formerly Kunskap), Fakta, Minne and Arbetssätt. Pure, so
 * the server redirect from /agent-knowledge and the client page share it.
 */
export const WIKI_VIEWS = ['context', 'map', 'facts', 'memory', 'skills'] as const
export type WikiView = (typeof WIKI_VIEWS)[number]

export function wikiViewHref(view: WikiView): string {
  return view === 'context' ? '/wiki' : `/wiki?view=${view}`
}

export function parseWikiView(raw: string | null | undefined): WikiView {
  return (WIKI_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as WikiView) : 'context'
}

/** The views of the old "Vad din agent vet" page (?view=), each to its wiki view. */
const LEGACY_VIEW: Readonly<Record<string, WikiView>> = { knowledge: 'map', facts: 'facts', memory: 'memory', skills: 'skills' }

/** Where an old /agent-knowledge link lands: its view, or the wiki's landing. */
export function legacyKnowledgeHref(view: string | null | undefined): string {
  return wikiViewHref((view && LEGACY_VIEW[view]) || 'context')
}
