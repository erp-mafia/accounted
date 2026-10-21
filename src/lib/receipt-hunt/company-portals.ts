/**
 * Where a supplier keeps its invoices, as the company itself said so.
 *
 * The portal directory (./portal-directory.ts) knows a handful of global
 * vendors. Every other supplier whose invoices wait behind a login (Telia,
 * Ellevio, a landlord's tenant page) is known only to the company that pays
 * it, so a person says it once, from the purchase in the Inkorg: "the invoice
 * is in a portal, here is the link". The row is stored per company
 * (public.company_portals) and, like the directory, matched at read time: it
 * answers for every purchase from that supplier, earlier ones included.
 *
 * Which purchases are "from that supplier": the key is the bank row's text
 * folded the way the Inkorg already folds it to say two bank rows are one
 * counterparty (bankKeyOf in lib/inkorg/expectations.ts) and the directory
 * folds it before its aliases are tried (lookupPortal): normalizeForMatch of
 * the merchant name, else the text. "TELIA SVERIGE AB" on two dates folds to
 * "telia sverige", and so does "TELIA SVERIGE AB AUTOGIRO": the fold drops
 * the legal form and the payment rail. A purchase matches a company portal
 * when its fold holds the portal's key as whole words, the way a directory
 * alias matches, so a longer text from the same supplier ("TELIA SVERIGE
 * FAKTURA") finds it too. The key is stored, so a change to normalizeForMatch
 * that drops or renames a word needs the keys folded again.
 *
 * Pure: no client, no I/O, no React. The URL rule runs in the browser as the
 * person types and again on the server before anything is stored.
 */
import { normalizeForMatch } from '@/lib/documents/core-receipt-matcher'
import { lookupPortal } from './portal-directory'
import { canHaveEmailReceipt } from './select'

/** One row of public.company_portals, as far as resolving reads it. */
export interface CompanyPortal {
  id: string
  counterparty_key: string
  vendor_name: string
  url: string
}

/**
 * Where a purchase's invoice waits: the company's own portal, else the
 * directory's. `id` is the company portal's row, null for a directory entry
 * (shared and curated, so nobody changes it from one company).
 */
export interface ResolvedPortal {
  vendor: string
  url: string
  note: string | null
  id: string | null
}

/** A key shorter than this names nobody ("ab", "se"): it would claim half the bank statement. */
export const MIN_PORTAL_KEY_LENGTH = 3

/** The longest supplier name a portal carries: the `?view=portal:` value takes no more (lib/inkorg/items.ts). */
export const MAX_PORTAL_VENDOR_LENGTH = 80

/** The longest link stored. */
export const MAX_PORTAL_URL_LENGTH = 2048

/**
 * The counterparty key of a bank descriptor: what a company portal is stored
 * under and matched by. Null when the fold leaves too little to name anyone.
 */
export function portalKeyFor(descriptor: string | null | undefined): string | null {
  const text = descriptor?.trim()
  if (!text) return null
  const key = normalizeForMatch(text)
  if (key.length < MIN_PORTAL_KEY_LENGTH || !/\p{L}/u.test(key)) return null
  return key
}

/** Whether a purchase's fold holds the portal's key as whole words. */
function holdsKey(folded: string, key: string): boolean {
  return ` ${folded} `.includes(` ${key} `)
}

/**
 * Where the invoice behind a bank descriptor waits: the company's own portal
 * first, then the directory. The longest matching key wins, as the
 * directory's longest alias does. Salary, tax and the like never get a
 * portal: they have no invoice to fetch, and a link there would be worse
 * than silence.
 */
export function resolvePortal(
  companyPortals: readonly CompanyPortal[],
  descriptor: string | null | undefined,
): ResolvedPortal | null {
  if (!descriptor || !canHaveEmailReceipt(descriptor)) return null

  const folded = normalizeForMatch(descriptor)
  let own: CompanyPortal | null = null
  if (folded) {
    for (const portal of companyPortals) {
      if (holdsKey(folded, portal.counterparty_key) && (!own || portal.counterparty_key.length > own.counterparty_key.length)) {
        own = portal
      }
    }
  }
  if (own) return { vendor: own.vendor_name, url: own.url, note: null, id: own.id }

  const entry = lookupPortal(descriptor)
  return entry ? { vendor: entry.vendor, url: entry.url, note: entry.note ?? null, id: null } : null
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type PortalUrlResult = { ok: true; url: string } | { ok: false }

/** A scheme at the start of what was pasted: "https:", "javascript:", "data:". */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
/** "minasidor.telia.se:8443/..." is a host and a port, not a scheme. */
const HOST_AND_PORT = /^[^/?#@:\s]+\.[^/?#@:\s]+:\d+(?:[/?#]|$)/
/** A host of dot-separated labels: "minasidor.telia.se", never "localhost" or "telia.". */
const DOTTED_HOST = /^[^.]+(?:\.[^.]+)+$/

/**
 * The link to store, from what a person pasted, or a refusal:
 *   - https only. A link without a scheme gets https:// in front; any other
 *     scheme (http:, javascript:, data:, mailto:) is refused;
 *   - no user name or password in it (user:pass@);
 *   - a host with a dot, and no whitespace anywhere;
 *   - the query string is dropped, since that is where one-time tokens and
 *     sessions ride; the path and the fragment stay (a portal routed on
 *     "#/billing" needs it);
 *   - at most 2048 characters.
 * A bare host keeps no trailing slash, the way the directory writes them.
 */
export function normalizePortalUrl(input: string | null | undefined): PortalUrlResult {
  let text = (input ?? '').trim()
  if (!text || text.length > MAX_PORTAL_URL_LENGTH * 2 || /\s/.test(text)) return { ok: false }

  if (text.startsWith('//')) text = `https:${text}`
  else {
    const scheme = SCHEME.exec(text)
    if (!scheme || HOST_AND_PORT.test(text)) text = `https://${text}`
    else if (scheme[1].toLowerCase() !== 'https') return { ok: false }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false }
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { ok: false }
  if (!DOTTED_HOST.test(url.hostname)) return { ok: false }

  url.search = ''
  let out = url.toString()
  if (url.pathname === '/' && !url.hash) out = out.replace(/\/$/, '')
  if (out.length > MAX_PORTAL_URL_LENGTH) return { ok: false }
  return { ok: true, url: out }
}
