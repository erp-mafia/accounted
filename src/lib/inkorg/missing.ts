/**
 * Saknar underlag on the new Inkorg page: the bank purchases with no
 * document at all (GET /api/extensions/ext/invoice-inbox/purchases), in the
 * order the view lists them, banded by month, with where each one's
 * underlag will come from and the focus view's answers.
 *
 * Every answer runs on an endpoint that already exists:
 *   - choose_file, and a file dropped on the row or the focus view: the
 *     inbox upload (POST /upload, or /upload/create and /upload/complete
 *     above the hosted body limit), then POST /items/:id/match-transaction
 *     with the purchase. The same two calls the Underlag workspace makes for
 *     a purchase's file (uploadForPurchase). Ångra is POST
 *     /items/:id/unmatch-transaction, which takes the document off the
 *     purchase again and leaves the file in the inbox;
 *   - open_portal: the supplier's billing page from the portal directory
 *     (lib/receipt-hunt/portal-directory.ts), which the endpoint resolves;
 *   - fetch_with_ai: Kvittojakten in the customer's own AI, the receipt-hunt
 *     hand-off (GET /api/receipt-hunt/agent-handoff names the AI clients);
 *   - connect_ai: no AI is connected, so the same place connects Claude.
 *
 * There is no "Inget underlag behövs" here: "Inget underlag krävs" is
 * recorded on a posted verifikat only, and none of these purchases is booked.
 *
 * Pure: no client, no I/O, no React.
 */
import { vendorKeyFor, vendorLook, type VendorKey } from '@/lib/vendor-marks'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { canHaveEmailReceipt } from '@/lib/receipt-hunt/select'
import { readableName } from './names'

/** A bank purchase with no underlag, one row of GET /purchases. */
export interface MissingPurchase {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string | null
  amount_sek: number | null
  portal: { vendor: string; url: string; note: string | null } | null
  /** The vendor's own icon from our logos bucket (lib/vendor-logos), when one is stored. */
  logo_url?: string | null
}

// ---------------------------------------------------------------------------
// Order and bands
// ---------------------------------------------------------------------------

/**
 * Newest first, then by id. The endpoint orders by date alone, so two
 * purchases on one day could swap places between two reads; the id keeps a
 * refetch from reshuffling the queue under the focus view.
 */
export function orderMissing<T extends Pick<MissingPurchase, 'id' | 'date'>>(purchases: readonly T[]): T[] {
  return [...purchases].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * The list in its two parts, each in the order given (pass orderMissing's):
 * what needs a person now, and what is on its way (GET
 * /api/inkorg/expectations names those). The focus view works through the
 * first part and then the second, the order the page lists them in.
 */
export function splitMissing<T extends Pick<MissingPurchase, 'id'>>(
  ordered: readonly T[],
  onTheWay: { has: (id: string) => boolean },
): { needsYou: T[]; onTheWay: T[] } {
  const needsYou: T[] = []
  const way: T[] = []
  for (const purchase of ordered) (onTheWay.has(purchase.id) ? way : needsYou).push(purchase)
  return { needsYou, onTheWay: way }
}

/** One month of the list: `month` is YYYY-MM. */
export interface MonthBand<T> {
  month: string
  purchases: T[]
}

/**
 * The list in month bands, in the order given (pass orderMissing's): a
 * year of purchases reads by month, the way a person looks for a receipt.
 */
export function bandByMonth<T extends Pick<MissingPurchase, 'date'>>(ordered: readonly T[]): MonthBand<T>[] {
  const bands: MonthBand<T>[] = []
  for (const purchase of ordered) {
    const month = purchase.date.slice(0, 7)
    const last = bands[bands.length - 1]
    if (last && last.month === month) last.purchases.push(purchase)
    else bands.push({ month, purchases: [purchase] })
  }
  return bands
}

// ---------------------------------------------------------------------------
// What a row says
// ---------------------------------------------------------------------------

/** Who was paid: the bank's merchant, else its text, else null (the row says "Okänt köp"). */
export function purchaseName(purchase: Pick<MissingPurchase, 'merchant_name' | 'description'>): string | null {
  return purchase.merchant_name?.trim() || purchase.description?.trim() || null
}

/** The bank's own text, when it says something the name does not. */
export function purchaseBankText(purchase: Pick<MissingPurchase, 'merchant_name' | 'description'>): string | null {
  const text = purchase.description?.trim() || null
  return text && text !== purchaseName(purchase) ? text : null
}

/**
 * How a purchase is shown: who it was (the bank's merchant name, else the
 * vendor its text names, else the text itself), the vendor for its mark, and
 * the bank's text when it says something the name does not. "OPENAI *CHATGPT
 * SUBSCR" with no merchant name reads as OpenAI over its bank text. The name
 * is set as a person reads it ("KAFE SOLROS" -> "Kafe Solros"); the bank text
 * stays as the bank wrote it.
 */
export function purchaseDisplay(purchase: Pick<MissingPurchase, 'merchant_name' | 'description'>): {
  name: string | null
  vendor: VendorKey | null
  bankText: string | null
} {
  const merchant = purchase.merchant_name?.trim() || null
  const text = purchase.description?.trim() || null
  const vendor = vendorKeyFor(merchant) ?? vendorKeyFor(text)
  const name = readableName(merchant ?? (vendor ? (vendorLook(vendor)?.title ?? null) : null) ?? text)
  const saysTheName = text !== null && text.toLocaleLowerCase('sv-SE') === name?.toLocaleLowerCase('sv-SE')
  return { name, vendor, bankText: text && !saysTheName ? text : null }
}

/**
 * The card rails' wording on a Swedish bank row: "Kortköp 260612 ...",
 * "... K8066 Kortköp/uttag", a bare leading "KORT", or the card's own token.
 * The same wording the receipt matcher folds away before it compares names
 * (CARD_VERB and CARD_TOKEN in lib/documents/core-receipt-matcher.ts).
 */
const CARD_WORDING = /\bkort\s?k[oö]p\b|^\s*kort\b|\bk\d{4}\b/i

/** Paid by card, as far as the bank's text says. */
export function looksLikeCardPurchase(description: string | null | undefined): boolean {
  return !!description && CARD_WORDING.test(description)
}

// ---------------------------------------------------------------------------
// Where the underlag will come from
// ---------------------------------------------------------------------------

/** What the page knows about the company's ways in, read once for the view. */
export interface RouteContext {
  /** The company's intake address, when it has one. */
  intakeAddress: string | null
  /** A WhatsApp number is linked, so a photo can be sent there. */
  whatsappLinked: boolean
}

/**
 * Where a purchase's underlag will come from, where the app already knows:
 *   - portal: the supplier keeps its invoices behind a login, and the
 *     portal directory knows the page;
 *   - photo: a card purchase with no known route, so the receipt is likely
 *     paper: photograph it (and send it in WhatsApp when a number is linked);
 *   - intake: anything else that can arrive by mail, to the intake address;
 *   - unknown: nothing to say (salary, tax and the like have no receipt to
 *     mail, and a company without an address has nowhere to mail it).
 */
export type UnderlagRoute =
  | { kind: 'portal'; vendor: string; url: string; note: string | null }
  | { kind: 'photo'; whatsapp: boolean }
  | { kind: 'intake'; address: string }
  | { kind: 'unknown' }

/**
 * The route for one purchase. Before the context is read only the portal is
 * known (it comes with the row), so a row's hint never changes from one
 * guess to another while the page loads.
 */
export function underlagRoute(
  purchase: Pick<MissingPurchase, 'description' | 'portal'>,
  context: RouteContext | null,
): UnderlagRoute {
  if (purchase.portal) return { kind: 'portal', ...purchase.portal }
  if (!context) return { kind: 'unknown' }
  if (looksLikeCardPurchase(purchase.description)) return { kind: 'photo', whatsapp: context.whatsappLinked }
  if (context.intakeAddress && canHaveEmailReceipt(purchase.description)) {
    return { kind: 'intake', address: context.intakeAddress }
  }
  return { kind: 'unknown' }
}

// ---------------------------------------------------------------------------
// The focus view's answers
// ---------------------------------------------------------------------------

/** What the receipt-hunt hand-off answers (GET /api/receipt-hunt/agent-handoff), as far as this reads it. */
export interface AiHandoff {
  /** The AI clients this user has connected over MCP. Empty: none. */
  clients: AiClient[]
}

export type MissingAction = 'open_portal' | 'choose_file' | 'fetch_with_ai' | 'connect_ai'

export const MAX_MISSING_ACTIONS = 3

export interface MissingDecision {
  route: UnderlagRoute
  /** At most three, the first one primary. */
  actions: MissingAction[]
}

/**
 * One question ("Underlaget saknas") and at most three answers:
 *   - a portal purchase leads with the portal, then the AI, then the file;
 *   - every other purchase leads with the file, then the AI.
 * The AI answer is Kvittojakten when a client is connected and connecting
 * Claude when none is; it is left out while the hand-off is unknown (its
 * read failed) and for a purchase no receipt exists for in any mailbox
 * (salary, tax): the hunt skips those, so a button for it would do nothing.
 */
export function missingDecision(
  purchase: Pick<MissingPurchase, 'description' | 'portal'>,
  context: RouteContext | null,
  handoff: AiHandoff | null,
): MissingDecision {
  const route = underlagRoute(purchase, context)
  const huntable = route.kind === 'portal' || canHaveEmailReceipt(purchase.description)
  const ai: MissingAction | null =
    !handoff || !huntable ? null : handoff.clients.length > 0 ? 'fetch_with_ai' : 'connect_ai'
  const actions: (MissingAction | null)[] =
    route.kind === 'portal' ? ['open_portal', ai, 'choose_file'] : ['choose_file', ai]
  return {
    route,
    actions: actions.filter((a): a is MissingAction => a !== null).slice(0, MAX_MISSING_ACTIONS),
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A drag that carries files (not text or a link dragged across the page). */
export function dragCarriesFiles(types: readonly string[] | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files')
}

/**
 * A drop of several files: the first becomes the purchase's underlag, the
 * rest are filed in the inbox. One document backs one purchase, and a
 * receipt scanned as two images must not lose its second page in silence.
 */
export function splitDroppedFiles<T>(files: readonly T[]): { underlag: T | null; extras: T[] } {
  const [underlag = null, ...extras] = files
  return { underlag, extras }
}
