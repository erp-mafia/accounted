/**
 * Which vendor a name is: a supplier name as read off a document ("Telia
 * Sverige AB"), a bank row's text ("OPENAI *CHATGPT SUBSCR", "AMZN Mktp SE")
 * or a merchant name ("Clas Ohlson"), to the key of its mark or monogram.
 *
 * Pure and conservative. A wrong logo on a payment is worse than no logo, so
 * a name matches only on whole words, in this order of care:
 *   - a phrase of two or more words matches anywhere ("google cloud");
 *   - a single word of five letters or more matches anywhere as a whole
 *     word, and from seven letters also with a tail glued on ("SPOTIFYAB");
 *   - a word of four letters or less ("ica", "sj", "bolt", "meta") matches
 *     only as the first word of the name, where a brand name stands in a
 *     bank text, unless it is spelled `anywhere` (it cannot be a word: "okq8").
 * The longest match wins; between equals, the earliest. A payment processor
 * in front of a merchant ("PAYPAL *SPOTIFY", "KLARNA*IKEA") is only the way
 * it was paid: the merchant behind it is the answer, and nobody when the
 * merchant is not known. Named on its own ("Klarna Bank AB") it is itself.
 */
import { VENDOR_MARKS, type VendorMarkKey } from './marks'
import { VENDOR_MONOGRAMS, type VendorMonogramKey } from './monograms'

export type VendorKey = VendorMarkKey | VendorMonogramKey

interface Alias {
  key: VendorKey
  tokens: string[]
  /** A short word allowed anywhere, not only first: it cannot be an ordinary word. */
  anywhere: boolean
}

type AliasSpec = string | { phrase: string; anywhere: true }

/** The names each vendor goes by, lower case, words separated by spaces. */
const ALIASES: Readonly<Record<VendorKey, readonly AliasSpec[]>> = {
  // Marks (Simple Icons)
  '1password': ['1password'],
  airbnb: ['airbnb'],
  anthropic: ['anthropic'],
  apple: ['apple', 'apple com', 'itunes', 'icloud', 'app store'],
  atlassian: ['atlassian'],
  bookingdotcom: ['booking com'],
  calendly: ['calendly'],
  claude: ['claude ai', 'claude com'],
  cloudflare: ['cloudflare'],
  cursor: ['cursor ai', 'cursor sh', 'anysphere'],
  deepl: ['deepl'],
  digitalocean: ['digitalocean', 'digital ocean'],
  dropbox: ['dropbox'],
  facebook: ['facebook', 'facebk'],
  figma: ['figma'],
  fiverr: ['fiverr'],
  github: ['github'],
  gmail: ['gmail'],
  godaddy: ['godaddy'],
  google: ['google', 'google workspace', 'gsuite', 'g suite', 'google ireland'],
  googleads: ['google ads', 'adwords', 'google adwords'],
  googlecloud: ['google cloud', 'gcp'],
  grammarly: ['grammarly'],
  hetzner: ['hetzner'],
  hubspot: ['hubspot'],
  ikea: ['ikea'],
  jetbrains: ['jetbrains'],
  klarna: ['klarna'],
  lidl: ['lidl'],
  linear: ['linear app', 'linear orbit'],
  mailchimp: ['mailchimp', 'mailchimp com', 'intuit mailchimp'],
  mediamarkt: ['mediamarkt', 'media markt'],
  meta: ['meta', 'meta platforms', 'meta ads'],
  miro: ['miro', 'miro com', 'realtimeboard'],
  norwegian: ['norwegian air', 'norwegian air shuttle', 'norwegian com'],
  notion: ['notion', 'notion so', 'notion labs'],
  ovh: ['ovh', 'ovhcloud'],
  paypal: ['paypal'],
  perplexity: ['perplexity'],
  proton: ['proton', 'proton ag', 'protonmail', 'proton me'],
  revolut: ['revolut'],
  ryanair: ['ryanair'],
  shopify: ['shopify'],
  spotify: ['spotify'],
  squarespace: ['squarespace', 'sqsp'],
  stripe: ['stripe', 'stripe com'],
  sumup: ['sumup'],
  supabase: ['supabase'],
  telenor: ['telenor'],
  tesla: ['tesla', 'tesla motors', 'tesla supercharger'],
  uber: ['uber', 'uber bv', 'uber trip', 'uber eats', 'uber com'],
  upwork: ['upwork'],
  vercel: ['vercel'],
  webflow: ['webflow'],
  whatsapp: ['whatsapp'],
  wise: ['wise', 'wise com', 'transferwise', 'wise europe'],
  wix: ['wix', 'wix com'],
  zoom: ['zoom', 'zoom us', 'zoom com', 'zoom video', 'zoom communications'],
  // Monograms
  telia: ['telia', 'telia sverige', 'telia company'],
  tele2: [{ phrase: 'tele2', anywhere: true }],
  tre: ['tre se', 'hi3g', 'hi3g access'],
  vattenfall: ['vattenfall'],
  clasohlson: ['clas ohlson', 'clasohlson'],
  circlek: ['circle k', 'circlek'],
  kjell: ['kjell company', 'kjell co', 'kjell och company', 'kjellcompany'],
  folksam: ['folksam'],
  securitas: ['securitas'],
  preem: ['preem'],
  okq8: [{ phrase: 'okq8', anywhere: true }],
  ica: ['ica', 'ica maxi', 'maxi ica', 'ica kvantum', 'ica supermarket', 'ica nara', 'ica sverige', 'ica gruppen'],
  coop: ['coop', 'coop sverige', 'coop konsum', 'stora coop', 'coop forum'],
  postnord: ['postnord'],
  sj: ['sj', 'sj ab', 'sj se'],
  biltema: ['biltema'],
  byggmax: ['byggmax'],
  apoteket: ['apoteket'],
  espressohouse: ['espresso house'],
  kivra: ['kivra'],
  peppol: ['peppol'],
  billo: ['billo'],
  openai: ['openai', 'open ai', 'chatgpt'],
  amazon: ['amazon', 'amzn', 'amazon mktp', 'amazon se', 'amazon eu', 'amazon prime'],
  aws: ['aws', 'amazon web services', 'aws emea'],
  adobe: ['adobe'],
  slack: ['slack', 'slack technologies', 'slack com'],
  canva: ['canva'],
  linkedin: ['linkedin'],
  microsoft: ['microsoft', 'msft', 'microsoft 365', 'office 365', 'outlook com'],
  bolt: ['bolt', 'bolt eu', 'bolt technology', 'bolt operations'],
}

/**
 * Payment processors that put their own name in front of the merchant's,
 * with an asterisk between ("PAYPAL *ACME", "SUMUP *KAFFEBAREN").
 */
const PROCESSORS: ReadonlySet<VendorKey> = new Set<VendorKey>(['paypal', 'klarna', 'stripe', 'sumup'])
const PROCESSOR_PREFIX = /^\s*([a-z0-9][a-z0-9 .]*?)\s*\*\s*(.+)$/i

/** Lower case, accents off, split on anything that is not a letter or a digit. */
export function vendorTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const SHORT = 4
const GLUE_MIN = 7

const COMPILED: readonly Alias[] = (Object.entries(ALIASES) as [VendorKey, readonly AliasSpec[]][]).flatMap(([key, specs]) =>
  specs.map((spec) =>
    typeof spec === 'string'
      ? { key, tokens: vendorTokens(spec), anywhere: false }
      : { key, tokens: vendorTokens(spec.phrase), anywhere: true },
  ),
)

interface Hit {
  key: VendorKey
  /** Words matched. */
  words: number
  /** Letters matched. */
  letters: number
  position: number
}

/** Where `alias` matches in `tokens`, or -1. */
function matchAt(alias: Alias, tokens: readonly string[]): number {
  const words = alias.tokens
  if (words.length === 0) return -1
  if (words.length > 1) {
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (words.every((w, j) => tokens[i + j] === w)) return i
    }
    return -1
  }
  const word = words[0]!
  if (word.length <= SHORT && !alias.anywhere) return tokens[0] === word ? 0 : -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === word) return i
    if (word.length >= GLUE_MIN && token.startsWith(word)) return i
  }
  return -1
}

function better(a: Hit, b: Hit | null): boolean {
  if (!b) return true
  if (a.words !== b.words) return a.words > b.words
  if (a.letters !== b.letters) return a.letters > b.letters
  return a.position < b.position
}

function bestHit(tokens: readonly string[], skip: ReadonlySet<VendorKey>): Hit | null {
  let best: Hit | null = null
  for (const alias of COMPILED) {
    if (skip.has(alias.key)) continue
    const position = matchAt(alias, tokens)
    if (position < 0) continue
    const hit = { key: alias.key, words: alias.tokens.length, letters: alias.tokens.join('').length, position }
    if (better(hit, best)) best = hit
  }
  return best
}

/**
 * The vendor a name or a bank text names, or null. Short names are read
 * only first in the text, so "ICA NARA" is ICA and "MUSICA AB" is nobody.
 */
export function vendorKeyFor(text: string | null | undefined): VendorKey | null {
  if (!text) return null

  // "PAYPAL *SPOTIFY": the processor is how it was paid; the merchant behind it is who was paid.
  const prefixed = PROCESSOR_PREFIX.exec(text)
  if (prefixed) {
    const front = bestHit(vendorTokens(prefixed[1]!), new Set())
    if (front && PROCESSORS.has(front.key)) {
      const behind = bestHit(vendorTokens(prefixed[2]!), PROCESSORS)
      return behind?.key ?? null
    }
  }

  const tokens = vendorTokens(text)
  if (tokens.length === 0) return null
  return bestHit(tokens, new Set())?.key ?? null
}

/** Every key the matcher can answer: each has a mark or a monogram. */
export const VENDOR_KEYS: readonly VendorKey[] = [
  ...(Object.keys(VENDOR_MARKS) as VendorMarkKey[]),
  ...(Object.keys(VENDOR_MONOGRAMS) as VendorMonogramKey[]),
]
