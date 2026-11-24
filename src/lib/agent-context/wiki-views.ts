/**
 * The wiki's views and their addresses (src/components/wiki/WikiViews.tsx):
 * Kontext (what the agent receives, the landing), Karta (the konteringskarta
 * and ledger profile, formerly Kunskap), Fakta, Minne and Arbetssätt. Pure, so
 * the server redirect from /agent-knowledge and the client page share it.
 *
 * For a company with the agent picture on (lib/env/agent-picture-switch.ts)
 * /wiki is the picture, and the address can name the row of the company's
 * card that is open: wikiPlace says what an address shows. It can instead
 * name the agent card that is open (pictureAgentOf).
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

/**
 * Where an old /agent-knowledge link lands: its view, or the wiki's landing.
 * With `picture` (the company has the agent picture on) it is where that
 * view is for such a company (pictureHrefOfView).
 */
export function legacyKnowledgeHref(view: string | null | undefined, { picture = false }: { picture?: boolean } = {}): string {
  const wikiView = (view && LEGACY_VIEW[view]) || 'context'
  return picture ? pictureHrefOfView(wikiView) : wikiViewHref(wikiView)
}

/** The rows of the company's card in the agent picture (components/agent-picture); each opens its own view. */
export const PICTURE_ROWS = ['context', 'checks', 'memory', 'knowledge'] as const
export type PictureRow = (typeof PICTURE_ROWS)[number]

export function isPictureRow(value: unknown): value is PictureRow {
  return typeof value === 'string' && (PICTURE_ROWS as readonly string[]).includes(value)
}

/**
 * The `view` values that name a row of the picture: the row's own name, and
 * `skills`, the wiki view that lists the knowledge where there is no picture.
 * (`knowledge` is the Kunskap row here; on /agent-knowledge the same word is
 * the bookkeeping profile, which LEGACY_VIEW reads.)
 */
const ROW_OF_VIEW: Readonly<Record<string, PictureRow>> = { context: 'context', checks: 'checks', memory: 'memory', knowledge: 'knowledge', skills: 'knowledge' }

/** The row of the picture a `view` value names; null when it names none. */
export function pictureRowOf(view: string | null | undefined): PictureRow | null {
  return view && Object.hasOwn(ROW_OF_VIEW, view) ? ROW_OF_VIEW[view] : null
}

/**
 * Whether the page reads the briefing (GET /api/wiki/context) as it loads.
 * Without the picture the context view is the briefing, so it does. With
 * the picture only the Kontext row's view shows the briefing: it is read at
 * load when the address names that row, and otherwise when the row is first
 * opened.
 */
export function readsBriefingAtLoad(picture: boolean, row: PictureRow | null | undefined): boolean {
  return !picture || row === 'context'
}

/** The query parameter that names one knowledge item of the Kunskap row. */
export const PICTURE_ITEM_PARAM = 'item'

/** A knowledge item in an address: its id with a dot for the slash ("horizontal.swedish-vat"), as /skills/kunskap.<item> spells it. */
export function knowledgeItemParam(id: string): string {
  return id.replace('/', '.')
}

/** The knowledge item an address names, as its id ("horizontal/swedish-vat"). */
export function knowledgeItemId(param: string): string {
  return param.replace('.', '/')
}

/**
 * The picture's address with one row open and, for Kunskap, optionally one
 * item's folder open (`item` as knowledgeItemParam spells it).
 */
export function pictureRowHref(row: PictureRow, item?: string | null): string {
  const query = new URLSearchParams({ view: row })
  if (row === 'knowledge' && item) query.set(PICTURE_ITEM_PARAM, item)
  return `/wiki?${query}`
}

/** The query parameter that names the open agent card of the picture, by the card's id (lib/agent-context/agent-cards.ts). */
export const PICTURE_AGENT_PARAM = 'agent'

/** The picture's address with one agent card open. */
export function pictureAgentHref(card: string): string {
  return `/wiki?${new URLSearchParams({ [PICTURE_AGENT_PARAM]: card })}`
}

/**
 * The agent card an address names, for an address that shows the picture.
 * A row and a card are not open at once: an address that names a row names
 * no card, so `view` and `item` mean what they mean without `agent`.
 */
export function pictureAgentOf(address: { view?: string | null; agent?: string | null }): string | null {
  if (pictureRowOf(address.view)) return null
  return address.agent ? address.agent : null
}

/**
 * Where the bookkeeping profile's lines are for a company with the picture:
 * the sentence above the list of Bokföringsregler (lib/agent-context/profile-line.ts).
 */
export const PICTURE_PROFILE_HREF = '/rules'

/**
 * Where each wiki view is for a company with the agent picture on: Minne
 * and Arbetssätt are rows of the picture, the map is on Bokföringsregler,
 * and the context view and Fakta keep their addresses.
 */
export function pictureHrefOfView(view: WikiView): string {
  if (view === 'map') return PICTURE_PROFILE_HREF
  if (view === 'memory') return pictureRowHref('memory')
  if (view === 'skills') return pictureRowHref('knowledge')
  return wikiViewHref(view)
}

/**
 * What decides where an address of the wiki ends, for one company: whether
 * it has the agent picture, whether it has Fakta, and whether the
 * installation has the agent connection (the MCP server extension; taken as
 * there when not given). lib/agent-context/wiki-company.ts reads it on the
 * server.
 */
export interface WikiCompany {
  picture: boolean
  facts: boolean
  agentConnection?: boolean
}

/** What /wiki shows for an address: one of its views, the picture with the row and the item the address names, or another page. */
export type WikiPlace =
  | { show: 'view'; view: WikiView }
  | { show: 'picture'; row: PictureRow | null; item: string | null }
  | { show: 'redirect'; href: string }

/**
 * What /wiki shows for `view` and `item`, for a company with or without the
 * agent picture (`picture`) and with or without Fakta (`facts`), on an
 * installation with or without the agent connection (`agentConnection`,
 * the MCP server extension; taken as there when not given).
 *
 * Without the picture it is the wiki view the address names: a `view` the
 * wiki does not know, the picture's own row names among them, lands on the
 * context view.
 *
 * With the picture, /wiki is the picture: a `view` that names a row opens
 * that row, and `item` one folder of the Kunskap row. The map leads to
 * Bokföringsregler, and Fakta (where the company has it) stays a view of
 * its own.
 *
 * With the picture on an installation without the agent connection there is
 * no picture to show (it is what a connected agent gets): every address
 * that would show it leads to Bokföringsregler, the other row of the
 * Agenter menu there, so neither the address nor a redirect into it ends on
 * a page that only says the connection does not exist.
 */
export function wikiPlace(address: { view?: string | null; item?: string | null }, company: WikiCompany): WikiPlace {
  const parsed = parseWikiView(address.view)
  const view = parsed === 'facts' && !company.facts ? 'context' : parsed
  if (!company.picture || view === 'facts') return { show: 'view', view }
  if (view === 'map' || company.agentConnection === false) return { show: 'redirect', href: PICTURE_PROFILE_HREF }
  const row = pictureRowOf(address.view)
  return { show: 'picture', row, item: row === 'knowledge' && address.item ? address.item : null }
}

/** The wiki's own path. */
const WIKI_PATH = '/wiki'

/**
 * Where an address ends for a company: the address itself when it is not
 * /wiki's, or when /wiki shows a page for it; the place /wiki leads on to
 * otherwise. It asks wikiPlace, the function /wiki itself asks, so a page
 * that forwards into the wiki and names this place forwards once: /wiki has
 * nothing left to forward, and the two cannot disagree.
 */
export function wikiDestination(href: string, company: WikiCompany): string {
  const hashAt = href.indexOf('#')
  const [path, search = ''] = (hashAt < 0 ? href : href.slice(0, hashAt)).split('?')
  if (path !== WIKI_PATH) return href
  const query = new URLSearchParams(search)
  const place = wikiPlace({ view: query.get('view'), item: query.get(PICTURE_ITEM_PARAM) }, company)
  return place.show === 'redirect' ? place.href : href
}

/**
 * An address (path, query and hash) without the picture's row, item and
 * agent card: where closing a row or a card leaves the page, so a reload
 * opens nothing. With `keepRow` only the item goes: the folder is closed and
 * its row stays open.
 */
export function withoutPictureRow(address: string, { keepRow = false }: { keepRow?: boolean } = {}): string {
  const hashAt = address.indexOf('#')
  const hash = hashAt < 0 ? '' : address.slice(hashAt)
  const [path, search = ''] = (hashAt < 0 ? address : address.slice(0, hashAt)).split('?')
  const query = new URLSearchParams(search)
  if (!keepRow) {
    query.delete('view')
    query.delete(PICTURE_AGENT_PARAM)
  }
  query.delete(PICTURE_ITEM_PARAM)
  const rest = query.toString()
  return `${path}${rest ? `?${rest}` : ''}${hash}`
}
