/**
 * Deny-by-default masking for PostHog session replay.
 *
 * Everything is masked unless it is app chrome (founder-approved 2026-08-17,
 * supersedes the 2026-08-06 pattern-based default where user content was
 * visible). Replays show layout, clicks and static UI text: headers, nav,
 * form labels, placeholders, buttons. They never show user data: not what a
 * user typed (input values are masked wholesale by rrweb, see
 * instrumentation-client.ts) and not user content rendered as text
 * (counterparty names, descriptions, amounts, identity numbers).
 *
 * What counts as chrome, i.e. renders readable in a replay:
 * - Any subtree tagged `data-ph-unmask`. Tags live on the shared UI
 *   primitives (nav, PageHeader, Label, Button, tabs, dialog/sheet titles,
 *   card titles, badges, tooltips, empty states), so page code gets readable
 *   chrome without per-page tagging.
 * - `<th>` elements with NO explicit tag anywhere above them: table column
 *   headers are static chrome, but the page-level dry-table pattern writes
 *   raw `<th className={TH_CLASS}>` per page, so there is no shared
 *   component to tag. An explicit data-ph-mask (on the th or any ancestor)
 *   always wins over this fallback.
 *
 * Chrome is still pattern-scrubbed (belt and braces): an i18n string that
 * interpolates an amount or a person-/organisationsnummer into a title or
 * button label gets that span masked even inside an unmasked subtree.
 *
 * `data-ph-mask` force-masks a subtree and wins over `data-ph-unmask`: the
 * NEAREST tagged ancestor decides, and mask wins when both attributes land
 * on the same element. Use it where user data flows into a chrome primitive
 * (e.g. a Label interpolating the user's email, a dialog title carrying a
 * counterparty name).
 *
 * Untagged text is fully masked, so the failure mode for new UI is
 * over-masking (asterisks where chrome should be readable), never leaking
 * a user's books.
 *
 * Known limit: rrweb masks text nodes and input values, not ATTRIBUTES.
 * posthog-js exposes no attribute mask hook, so a title/aria-label/
 * placeholder attribute is recorded as-is. An element whose attributes
 * carry user data (e.g. a placeholder prefilled with an effective value)
 * must carry the `ph-no-capture` class instead: rrweb's blockClass removes
 * the whole element from the recording while the app UX is untouched. Do
 * not put user data in title or aria-label attributes.
 */

/**
 * Currency-shaped text: optional sign (Intl sv-SE renders negative amounts
 * with U+2212, hand-written strings use '-'), digits with space/nbsp grouping
 * and a decimal part, then a currency marker. The trailing lookahead rejects
 * letter continuations so "10 kronor" or "SEKTION" never match.
 */
const AMOUNT_PATTERN = new RegExp(
  // − is the Unicode minus sign Intl sv-SE emits for negative amounts.
  String.raw`[-−]?\d(?:[\d\s]|[.,](?=\d))*\s?(?:kr|sek|eur|usd|nok|dkk|gbp|chf|us\$|\$|€|£)(?![\p{L}\d])`,
  'giu',
)

/**
 * Person-/organisationsnummer rendered as text: 6 or 8 digits, separator,
 * 4 digits ("556677-8899", "19850101-1234", "850101+1234"). The digit
 * lookarounds keep bankgiro ("5050-1055"), phone numbers and dates out.
 */
const IDENTITY_TEXT_PATTERN = /(?<!\d)\d{6}(?:\d{2})?[-+]\d{4}(?!\d)/g

const TAG_SELECTOR = '[data-ph-mask],[data-ph-unmask]'

/** Length-preserving mask: whitespace survives so table layout stays legible. */
function maskAll(text: string): string {
  return text.replace(/\S/g, '*')
}

function maskSpan(span: string): string {
  return maskAll(span)
}

/**
 * Masks currency amounts and separator-formatted identity numbers inside a
 * text node, leaving the surrounding text readable. Applied to CHROME text:
 * non-chrome text never gets here, it is masked wholesale.
 */
export function maskSensitiveText(text: string): string {
  return text.replace(AMOUNT_PATTERN, maskSpan).replace(IDENTITY_TEXT_PATTERN, maskSpan)
}

/**
 * `session_recording.maskTextFn`. Runs on EVERY text node because
 * `maskTextSelector: '*'` flags them all; this function then decides.
 * Default is masked; only chrome shows through, and even chrome is
 * pattern-scrubbed.
 *
 * Explicit tags are resolved FIRST, and only then the th fallback: a single
 * closest() over tags-plus-th would let a th nested inside a data-ph-mask
 * container win on DOM proximity and unmask it.
 */
export function replayMaskText(text: string, element?: HTMLElement): string {
  const tagged = element?.closest?.(TAG_SELECTOR)
  if (tagged) {
    return tagged.hasAttribute('data-ph-mask') ? maskAll(text) : maskSensitiveText(text)
  }
  return element?.closest?.('th') ? maskSensitiveText(text) : maskAll(text)
}
