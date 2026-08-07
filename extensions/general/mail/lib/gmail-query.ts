/**
 * Turning a bank purchase into a Gmail search.
 *
 * Pure, because this is where recall is won or lost and it must be testable
 * without a mailbox. The search runs provider-side and only the hits come back:
 * we never sync or index a mailbox, which is what keeps the feature inside
 * Google's Limited Use terms and inside GDPR data minimisation.
 */
import type { MailSearchQuery } from '@/lib/mail-search/service'

/**
 * How far around the purchase date to look.
 *
 * Asymmetric on purpose: a receipt is normally emailed at or just after the
 * purchase, while the bank may post the charge a few days late, so the mail can
 * legitimately predate the transaction date. Card settlement is the reason for
 * the tail, and Pleo Fetch uses the same shape (-3 / +10).
 */
export const DAYS_BEFORE = 3
export const DAYS_AFTER = 10

/**
 * Merchant tokens too generic to search on alone.
 *
 * The bank's description is not a merchant name: it is whatever the payer typed
 * plus the rail it went over. Month names and rail words are in here because a
 * provkörning on a real ledger showed "Lön Juli Jakob Överföring via internet"
 * searching for `"Juli"`, which matches most of a mailbox and returned the same
 * seven unrelated messages for every purchase.
 */
const STOPWORDS = new Set([
  'ab', 'hb', 'kb', 'inc', 'llc', 'ltd', 'gmbh', 'oy', 'pbc', 'plc', 'corp', 'co',
  'the', 'and', 'och', 'group', 'sweden', 'sverige', 'international', 'kortkop',
  'kortköp', 'uttag', 'betalning', 'payment', 'store', 'shop', 'www', 'com',
  // Payment rails and the bank's own boilerplate.
  'överföring', 'overforing', 'internet', 'via', 'bankgiro', 'plusgiro', 'autogiro',
  'bgbet', 'bg-bet', 'insättning', 'insattning', 'inbetalning', 'utbetalning',
  'europabetalning', 'swish', 'faktura', 'invoice', 'kortköputtag', 'kortkoputtag',
  // Months, Swedish and English, full and abbreviated.
  'januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti',
  'september', 'oktober', 'november', 'december',
  'january', 'february', 'march', 'may', 'june', 'july', 'august', 'october',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'okt', 'oct',
  'nov', 'dec',
])

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return isoDay(d)
}

/**
 * Pick the tokens worth searching for. Short and generic tokens are dropped:
 * a query for "ab" returns the whole mailbox and costs a page of results for
 * nothing.
 */
export function merchantTerms(merchant: string | null): string[] {
  if (!merchant) return []
  return merchant
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
    .slice(0, 3)
}

/**
 * Format the amount the way a receipt would write it, so the number itself
 * becomes a search term. Swedish receipts write 1 234,50; most SaaS invoices
 * write 1234.50. Both forms are offered.
 */
export function amountTerms(amount: number): string[] {
  const abs = Math.abs(amount)
  const twoDp = abs.toFixed(2)
  const terms = new Set<string>([twoDp, twoDp.replace('.', ',')])
  if (Number.isInteger(abs)) terms.add(String(abs))

  // Swedish invoices group thousands with a space: 15 000,00, not 15000,00.
  // Measured against a real mailbox, the Sting office invoice was findable as
  // "15 000,00" and "15 000" and by nothing else: every ungrouped form
  // returned zero. Cheap to add and it is pure recall.
  const group = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const [whole] = twoDp.split('.')
  if (whole.length > 3) {
    terms.add(`${group(whole)},${twoDp.split('.')[1]}`)
    terms.add(group(whole))
  }
  return [...terms]
}

/**
 * Build the Gmail `q` for one purchase.
 *
 * Structure: a date window, then merchant OR amount. It is deliberately an OR:
 * requiring both misses the common cases where the bank's merchant string does
 * not appear in the receipt at all (a reseller, a parent company, a brand alias
 * like Anthropic billing as Claude), and the amount alone is a strong filter
 * inside a two-week window.
 *
 * `has:attachment` is NOT required: plenty of receipts are the mail body itself.
 */
export function buildGmailQuery(query: MailSearchQuery): string {
  const parts: string[] = []

  // Off by default now. Receipts reach these mailboxes by being forwarded, and
  // a forward carries the forwarding date, so windowing on the purchase date
  // hides the very mail we want. The caller re-establishes precision by having
  // the model judge the hits instead.
  if (query.useDateWindow !== false) {
    const after = shiftDays(query.date, -DAYS_BEFORE - 1) // Gmail's after: is exclusive
    const before = shiftDays(query.date, DAYS_AFTER + 1)
    parts.push(`after:${after.replace(/-/g, '/')}`, `before:${before.replace(/-/g, '/')}`)
  }

  // Merchant OR amount, never one instead of the other.
  //
  // The amount is the single strongest signal a reconciliation has: dates drift
  // because banks post late and mail gets forwarded, but an amount does not
  // drift. Gmail indexes text inside PDF attachments, so a Swedish receipt is
  // often findable by its total alone. It is an OR rather than an AND because
  // neither signal survives every case: a receipt billed in USD never contains
  // the SEK figure the bank charged, and a bank descriptor frequently names
  // nothing that appears in the receipt.
  const aliases = (query.aliases ?? []).map((a) => a.trim()).filter((a) => a.length >= 2)
  const names = aliases.length > 0 ? aliases : merchantTerms(query.merchant)
  const alternatives = [
    ...amountTerms(query.amount).map((a) => `"${a}"`),
    ...names.map((t) => `"${t}"`),
  ]

  if (alternatives.length > 0) {
    parts.push(`(${alternatives.join(' OR ')})`)
  }

  if (query.requireAttachment) parts.push('has:attachment')

  // Calendar invitations and the user's own outbound mail are never receipts.
  parts.push('-in:chats')

  return parts.join(' ')
}

/**
 * Cheap pre-filter on a hit before spending a model call on it.
 *
 * Gmail's OR query is broad by design, so most hits are not receipts. Anything
 * that looks like a newsletter or a calendar notice is dropped here rather than
 * being read.
 */
const OBVIOUS_NON_RECEIPT = /\b(nyhetsbrev|newsletter|unsubscribe|prenumerera|kalender|calendar invite|inbjudan)\b/i

export function looksLikeReceipt(subject: string | null, from: string | null): boolean {
  const haystack = `${subject ?? ''} ${from ?? ''}`
  if (OBVIOUS_NON_RECEIPT.test(haystack)) return false
  return true
}
