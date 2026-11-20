/**
 * Which website a counterpart is, for its logo. Pure.
 *
 * Strongest evidence first:
 *   a. a host written in the text itself ("APPLE.COM/BILL", "INET.SE",
 *      "WWW.CINODE.COM"), common TLDs only; a host the counterparty
 *      directory seed names outright ("msbill.info" is Microsoft) is read
 *      as the seed says;
 *   b. the counterparty directory seed's logo domain
 *      (lib/parties/resolver/directory-seed.ts);
 *   c. the curated aliases (./aliases.ts): the built-in marks' matcher
 *      with a domain per vendor, then the merchant list;
 *   d. a supplier's mail address or a document's sender, only when the
 *      domain's main label is the counterpart's own name ("telia.se" for
 *      "Telia Sverige AB"; never "billogram.com" for "Hallon").
 * A domain on the exclusion list (./excluded.ts) is never an answer at any
 * step. A domain is never guessed from a name alone.
 *
 * A payment processor written in front of the merchant ("PADDLE.NET*
 * FASTMAIL", "SVEA*EDEKLARERA.SE", "MOL*RINKEL B V") is only how it was
 * paid: the text behind the star is read, and nothing when it names no
 * site we know.
 */
import { DIRECTORY_SEED } from '@/lib/parties/resolver/directory-seed'
import { matchSeedText } from '@/lib/parties/resolver/directory'
import { vendorTokens } from '@/lib/vendor-marks'
import { emailDomain, hostsInText, mainLabel, registrableDomain } from './domain'
import { isExcludedDomain } from './excluded'
import { merchantAliasDomain, vendorKeyDomain } from './aliases'

export type DomainSource = 'text' | 'directory' | 'alias' | 'email'

export interface ResolvedDomain {
  domain: string
  source: DomainSource
}

export interface CounterpartHints {
  /** The counterpart's name as shown: a supplier name, a bank merchant name. */
  name: string | null | undefined
  /** More text about the same counterpart: the bank row's own text. */
  texts?: ReadonlyArray<string | null | undefined>
  /** Mail addresses the counterpart's documents came from or that its supplier record holds. */
  emails?: ReadonlyArray<string | null | undefined>
}

/** Processors that write their own name before the merchant's, with a star between. */
const PROCESSOR_FRONTS: ReadonlySet<string> = new Set([
  'paypal', 'pp', 'klarna', 'stripe', 'sumup', 'zettle', 'izettle', 'paddle', 'paddle net', 'paddle com',
  'mol', 'mollie', 'svea', 'sq', 'square', 'fs', 'fastspring', 'dri', '2co', 'lemsqzy', 'nets', 'bambora', 'adyen',
])
const STARRED = /^\s*([^*]{1,40}?)\s*\*\s*(.+)$/

/** The text to read: what follows a payment processor's star, or the text itself. */
function behindProcessor(text: string): string {
  const m = STARRED.exec(text)
  if (!m) return text
  const front = vendorTokens(m[1]!).join(' ')
  return PROCESSOR_FRONTS.has(front) ? m[2]! : text
}

/** Seed hosts written as patterns ("msbill.info", "paddle.net"), to the seed's own logo domain. */
const SEED_HOSTS: ReadonlyMap<string, string> = new Map(
  DIRECTORY_SEED.flatMap((entry) =>
    entry.logoDomain
      ? entry.patterns
          .filter((p) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(p))
          .map((p): [string, string] => [p, entry.logoDomain!])
      : [],
  ),
)

function usable(domain: string | null | undefined): string | null {
  const d = registrableDomain(domain)
  return d && !isExcludedDomain(d) ? d : null
}

function fromHosts(text: string): string | null {
  for (const host of hostsInText(text)) {
    const seeded = SEED_HOSTS.get(host)
    const d = usable(seeded ?? host)
    if (d) return d
  }
  return null
}

function fromSeed(text: string): string | null {
  return usable(matchSeedText(text)?.logoDomain)
}

function fromAliases(text: string): string | null {
  return usable(vendorKeyDomain(text)) ?? usable(merchantAliasDomain(text))
}

/** Name words that never identify a brand on their own. */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  'ab', 'abp', 'hb', 'kb', 'publ', 'aktiebolag', 'handelsbolag', 'kommanditbolag', 'ef', 'inc', 'ltd', 'llc', 'gmbh',
  'ag', 'as', 'asa', 'oy', 'oyj', 'aps', 'bv', 'nv', 'sa', 'sarl', 'srl', 'plc', 'co', 'corp', 'company', 'limited',
  'sverige', 'sweden', 'svenska', 'swedish', 'nordic', 'nordics', 'scandinavia', 'europe', 'international', 'group',
  'holding', 'the', 'och', 'and', 'of', 'i', 'filial', 'kundservice', 'faktura', 'invoice', 'billing', 'info',
])

/**
 * Whether a domain's main label is the counterpart's own name: one of its
 * words ("telia" in "Telia Sverige AB"), or two or three of its words run
 * together ("clasohlson" for "Clas Ohlson"). Hyphens in the label are
 * ignored ("kjell-och-company").
 */
export function domainMatchesName(domain: string, name: string | null | undefined): boolean {
  if (!name) return false
  const label = mainLabel(domain).replace(/-/g, '')
  if (label.length < 2) return false
  const tokens = vendorTokens(name)
  for (let i = 0; i < tokens.length; i++) {
    let joined = ''
    for (let j = i; j < Math.min(tokens.length, i + 3); j++) {
      joined += tokens[j]!
      if (j === i && GENERIC_NAME_TOKENS.has(tokens[j]!)) break
      if (joined === label) return true
    }
  }
  return false
}

function fromEmails(name: string | null | undefined, emails: ReadonlyArray<string | null | undefined>): string | null {
  for (const email of emails) {
    const d = usable(emailDomain(email))
    if (d && domainMatchesName(d, name)) return d
  }
  return null
}

/** The website a counterpart is, and on what evidence, or null. */
export function resolveVendorDomain(hints: CounterpartHints): ResolvedDomain | null {
  const texts = [...new Set([hints.name, ...(hints.texts ?? [])].map((t) => t?.trim()).filter((t): t is string => !!t))].map(
    behindProcessor,
  )
  for (const t of texts) {
    const d = fromHosts(t)
    if (d) return { domain: d, source: 'text' }
  }
  for (const t of texts) {
    const d = fromSeed(t)
    if (d) return { domain: d, source: 'directory' }
  }
  for (const t of texts) {
    const d = fromAliases(t)
    if (d) return { domain: d, source: 'alias' }
  }
  const d = fromEmails(hints.name, hints.emails ?? [])
  return d ? { domain: d, source: 'email' } : null
}
