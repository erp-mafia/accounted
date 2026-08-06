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

/** Merchant tokens too generic to search on alone. */
const STOPWORDS = new Set([
  'ab', 'hb', 'kb', 'inc', 'llc', 'ltd', 'gmbh', 'oy', 'pbc', 'plc', 'corp', 'co',
  'the', 'and', 'och', 'group', 'sweden', 'sverige', 'international', 'kortkop',
  'kortköp', 'uttag', 'betalning', 'payment', 'store', 'shop', 'www', 'com',
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
  const after = shiftDays(query.date, -DAYS_BEFORE - 1) // Gmail's after: is exclusive
  const before = shiftDays(query.date, DAYS_AFTER + 1)

  const parts: string[] = [`after:${after.replace(/-/g, '/')}`, `before:${before.replace(/-/g, '/')}`]

  const terms = merchantTerms(query.merchant)
  const amounts = amountTerms(query.amount)
  const alternatives = [
    ...terms.map((t) => `"${t}"`),
    ...amounts.map((a) => `"${a}"`),
  ]

  if (alternatives.length > 0) {
    parts.push(`(${alternatives.join(' OR ')})`)
  }

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
