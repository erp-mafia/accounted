/**
 * Pattern-based masking for PostHog session replay.
 *
 * Replays are visible by default so support can see WHERE a user gets stuck
 * and WHAT they typed while getting there. What must never be readable in a
 * replay is the content of a user's books and identity numbers:
 *
 * 1. Monetary amounts. Every amount in the app renders through
 *    `formatCurrency()` (Intl sv-SE currency style, e.g. "1 234,56 kr"), so a
 *    currency-shaped text pattern covers transactions, vouchers, reports,
 *    invoices and dashboards in one place, including future code, without
 *    tagging hundreds of render sites.
 * 2. Person- and organisationsnummer. For an enskild firma the orgnr IS the
 *    owner's personnummer. Masked both as rendered text (formatOrgNumber()
 *    output, "556677-8899") and as typed input values.
 * 3. Passwords. Always masked, never overridable.
 *
 * Tag overrides (nearest tagged ancestor wins, mask wins on a tie):
 * - `data-ph-mask` force-masks an element's whole subtree (used on deliberate
 *   PII spots: company name / email in danger-zone labels, user-defined
 *   dimension names, nav count bubbles).
 * - `data-ph-unmask` exempts a subtree from pattern masking (static chrome
 *   such as form labels and nav). It never unmasks a password input.
 *
 * Known limits, accepted deliberately: masking is length-preserving (star
 * count reveals magnitude, layout stays stable in the replay), bare numbers
 * without a currency marker stay visible, and an identity number rendered
 * WITHOUT its separator is only caught on the input side.
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

/**
 * A typed input value that is (or is on its way to becoming) a person-/
 * organisationsnummer: 6 or more leading digits, optionally a separator and
 * up to 4 more. Matching from the 6th digit means intermediate keystroke
 * snapshots never ship the birthdate prefix of a personnummer. Accepted
 * over-masking: any bare 6-12 digit value (e.g. a raw amount over 99 999)
 * is masked too; amounts with decimals or thousand separators stay visible.
 */
const IDENTITY_INPUT_PATTERN = /^\s*\d{6,8}[-+ ]?\d{0,4}\s*$/

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
 * text node, leaving the surrounding text readable.
 */
export function maskSensitiveText(text: string): string {
  return text.replace(AMOUNT_PATTERN, maskSpan).replace(IDENTITY_TEXT_PATTERN, maskSpan)
}

/**
 * `session_recording.maskTextFn`. Runs on EVERY text node because
 * `maskTextSelector: '*'` flags them all; this function then decides.
 */
export function replayMaskText(text: string, element?: HTMLElement): string {
  const tagged = element?.closest(TAG_SELECTOR)
  if (tagged) {
    return tagged.hasAttribute('data-ph-mask') ? maskAll(text) : text
  }
  return maskSensitiveText(text)
}

/**
 * `session_recording.maskInputFn`. rrweb only invokes this on inputs flagged
 * by `maskInputOptions`, so the config sets `maskAllInputs: true` to flag
 * every input and this function selectively passes values through. Password
 * checks come first: not even `data-ph-unmask` may reveal one.
 */
export function replayMaskInput(text: string, element?: HTMLElement): string {
  if ((element as HTMLInputElement | undefined)?.type === 'password') {
    return maskAll(text)
  }
  const tagged = element?.closest?.(TAG_SELECTOR)
  if (tagged) {
    return tagged.hasAttribute('data-ph-mask') ? maskAll(text) : text
  }
  if (IDENTITY_INPUT_PATTERN.test(text)) {
    return maskAll(text)
  }
  return text
}
