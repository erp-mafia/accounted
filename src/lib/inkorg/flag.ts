/**
 * The new Inkorg page (/inkorg) rolls out per company (product decision
 * 2026-10-16). A company has one inbox, and the menu's Inkommande row leads
 * to it: the new page inside the rollout, the workspace
 * (/e/general/invoice-inbox) outside it.
 *
 * The two addresses lead to the same one inbox (lib/inkorg/inbox-page.ts).
 * For a company whose inbox is the new page (in the rollout, the extension
 * installed, no sandbox lock, the capability held), a request for the
 * workspace's address is redirected to the new page. For every other
 * company a request for the new page's address is redirected to the
 * workspace, which is also where the paywall and the sandbox lock are shown.
 * So a link to either address reaches the company's inbox, and a company on
 * the new page never opens the workspace.
 *
 * INKORG_V2_COMPANY_IDS lists the companies (comma-separated ids, or `*`
 * for everyone); unset means nobody, so a deploy never moves anyone's inbox.
 */
export function inkorgV2Rollout(): 'all' | string[] {
  const raw = process.env.INKORG_V2_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this company sees the new Inkorg page and its place in the sidebar. */
export function isInkorgV2Enabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false
  const rollout = inkorgV2Rollout()
  return rollout === 'all' || rollout.includes(companyId)
}

/** Where the inbox lives without the flag: the workspace of the invoice-inbox extension. */
export const LEGACY_INBOX_HREF = '/e/general/invoice-inbox'

/** The new page. */
export const INKORG_HREF = '/inkorg'

/** `/inkorg?view=<key>` opens that view of the list (lib/inkorg/items.ts parseViewKey); without it, Behöver dig. */
export const INKORG_VIEW_QUERY = 'view'

/**
 * `/inkorg?fokus=<item id>` opens that document in the focus view, and
 * `?fokus=forsta` the first one of Behöver dig: the address a Börja step
 * (Att göra) sends its rows and its primary to. Read once, when the list has
 * loaded; an id that is not waiting any more opens the list.
 */
export const INKORG_FOCUS_QUERY = 'fokus'
export const INKORG_FOCUS_FIRST = 'forsta'

/**
 * Where the inbox lives for a company, for anything that links to it
 * outside the menu (the worklist, the agent picture, a landed document): the
 * new page in the rollout, else the workspace, the same split the menu
 * makes. A link that was built without the flag and names the other address
 * still arrives: the routes redirect (lib/inkorg/inbox-page.ts).
 */
export function inboxHref(inkorgV2Enabled: boolean): string {
  return inkorgV2Enabled ? INKORG_HREF : LEGACY_INBOX_HREF
}

/**
 * The words the command palette finds the inbox by, under either name.
 * An utlägg starts here (the receipt, then "Vem betalade?"), and the
 * Utlägg menu row stays hidden until the first claim exists, so "utlägg"
 * and "kvitto" must land on the inbox rather than on nothing (PH 201).
 * The menu calls the inbox Inkommande, and people ask for "inkorgen": a
 * typed word must be found whole, so the definite form is a word of its own.
 * Swedish in every locale: it is what people type, not text on screen.
 */
export const INBOX_SEARCH_KEYWORDS =
  'inkorg inkorgen dokumentinkorg dokumentinkorgen underlag kvitto kvitton utlägg eget utlägg privat betalat fakturor saknar underlag inbox receipt expense'
