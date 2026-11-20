/**
 * The curated, reviewed part of vendor-logo resolution: which website a
 * vendor name means, for the vendors companies most often share.
 *
 * Two lists, both public brand facts:
 *   - VENDOR_KEY_DOMAINS: a domain for every vendor the built-in marks
 *     know (lib/vendor-marks), so the same matcher that picks a mark also
 *     names the site. Null where the vendor is excluded from fetching (a
 *     bank, a mail or invoice platform) or its site is not a brand site.
 *   - MERCHANT_ALIASES: brands outside the marks and outside the
 *     counterparty directory seed, from the merchants that three or more
 *     companies pay (read-only count, 2026-10-17). Only clear brands: never
 *     a person, never a name only one company uses.
 *
 * Matching is the vendor-marks rule (lib/vendor-marks/match.ts): whole
 * words, a phrase anywhere, a word of five letters or more anywhere, a
 * shorter word only first in the text.
 */
import { vendorKeyFor, vendorTokens, type VendorKey } from '@/lib/vendor-marks'

export const VENDOR_KEY_DOMAINS: Readonly<Record<VendorKey, string | null>> = {
  // Marks
  '1password': '1password.com',
  airbnb: 'airbnb.com',
  anthropic: 'anthropic.com',
  apple: 'apple.com',
  atlassian: 'atlassian.com',
  bookingdotcom: 'booking.com',
  calendly: 'calendly.com',
  claude: 'claude.ai',
  cloudflare: 'cloudflare.com',
  cursor: 'cursor.com',
  deepl: 'deepl.com',
  digitalocean: 'digitalocean.com',
  dropbox: 'dropbox.com',
  facebook: 'facebook.com',
  figma: 'figma.com',
  fiverr: 'fiverr.com',
  github: 'github.com',
  gmail: null, // free-mail; the door, not a vendor
  godaddy: 'godaddy.com',
  google: 'google.com',
  googleads: 'google.com',
  googlecloud: 'google.com',
  grammarly: 'grammarly.com',
  hetzner: 'hetzner.com',
  hubspot: 'hubspot.com',
  ikea: 'ikea.com',
  jetbrains: 'jetbrains.com',
  klarna: null, // bank logos
  lidl: 'lidl.se',
  linear: 'linear.app',
  mailchimp: 'mailchimp.com',
  mediamarkt: 'mediamarkt.se',
  meta: 'meta.com',
  miro: 'miro.com',
  norwegian: 'norwegian.com',
  notion: 'notion.com',
  ovh: 'ovhcloud.com',
  paypal: null, // bank logos
  perplexity: 'perplexity.ai',
  proton: null, // proton.me is a free-mail domain
  revolut: null, // bank
  ryanair: 'ryanair.com',
  shopify: 'shopify.com',
  spotify: 'spotify.com',
  squarespace: 'squarespace.com',
  stripe: null, // bank logos
  sumup: 'sumup.com',
  supabase: 'supabase.com',
  telenor: 'telenor.se',
  tesla: 'tesla.com',
  uber: 'uber.com',
  upwork: 'upwork.com',
  vercel: 'vercel.com',
  webflow: 'webflow.com',
  whatsapp: 'whatsapp.com',
  wise: null, // bank
  wix: 'wix.com',
  zoom: 'zoom.com',
  // Monograms
  telia: 'telia.se',
  tele2: 'tele2.se',
  tre: 'tre.se',
  vattenfall: 'vattenfall.se',
  clasohlson: 'clasohlson.com',
  circlek: 'circlek.se',
  kjell: 'kjell.com',
  folksam: 'folksam.se',
  securitas: 'securitas.se',
  preem: 'preem.se',
  okq8: 'okq8.se',
  ica: 'ica.se',
  coop: 'coop.se',
  postnord: 'postnord.se',
  sj: 'sj.se',
  biltema: 'biltema.se',
  byggmax: 'byggmax.se',
  apoteket: 'apoteket.se',
  espressohouse: 'espressohouse.com',
  kivra: null, // sends on behalf of others
  peppol: null, // a network, not a vendor
  billo: null, // invoices on behalf of others
  openai: 'openai.com',
  amazon: 'amazon.se',
  aws: 'amazon.com',
  adobe: 'adobe.com',
  slack: 'slack.com',
  canva: 'canva.com',
  linkedin: 'linkedin.com',
  microsoft: 'microsoft.com',
  bolt: 'bolt.eu',
}

interface MerchantAlias {
  domain: string
  /** The names it goes by, lower case, words separated by spaces. */
  names: readonly string[]
}

/** Brands the marks and the directory seed do not cover. */
export const MERCHANT_ALIASES: readonly MerchantAlias[] = [
  { domain: 'wework.com', names: ['wework'] },
  { domain: 'hallon.se', names: ['hallon'] },
  { domain: 'shipmondo.com', names: ['shipmondo'] },
  { domain: 'inleed.se', names: ['inleed'] },
  { domain: 'glesys.com', names: ['glesys'] },
  { domain: 'intrum.com', names: ['intrum'] },
  { domain: 'walley.se', names: ['walley'] },
  { domain: 'proshop.se', names: ['proshop'] },
  { domain: 'render.com', names: ['render com'] },
  { domain: 'ingrammicro.com', names: ['ingram micro'] },
  { domain: 'fora.se', names: ['fora ab'] },
  { domain: 'jlcpcb.com', names: ['jlcpcb'] },
  { domain: 'byteplus.com', names: ['byteplus'] },
  { domain: 'ahlsell.se', names: ['ahlsell'] },
  { domain: 'cinode.com', names: ['cinode'] },
  { domain: 'electrokit.com', names: ['electrokit'] },
  { domain: 'hostinger.com', names: ['hostinger'] },
  { domain: 'openrouter.ai', names: ['openrouter'] },
  { domain: 'fastmail.com', names: ['fastmail'] },
  { domain: 'x.ai', names: ['xai', 'grok'] },
  { domain: 'x.com', names: ['x corp'] },
  { domain: 'goteborgenergi.se', names: ['goteborg energi', 'göteborg energi'] },
  { domain: 'strato.de', names: ['strato'] },
  { domain: 'hostup.se', names: ['hostup'] },
  { domain: 'oderland.se', names: ['oderland'] },
  { domain: 'conrad.se', names: ['conrad elektronik'] },
  { domain: 'starlink.com', names: ['starlink'] },
  { domain: 'teamviewer.com', names: ['teamviewer'] },
  { domain: 'thomann.de', names: ['thomann'] },
  { domain: 'linear.app', names: ['linear software'] },
  { domain: 'amazon.se', names: ['amazonretail'] },
  { domain: 'accounted.se', names: ['accounted'] },
]

const SHORT = 4

interface Compiled {
  domain: string
  tokens: string[]
}

const COMPILED: readonly Compiled[] = MERCHANT_ALIASES.flatMap((a) =>
  a.names.map((name) => ({ domain: a.domain, tokens: vendorTokens(name) })),
)

function matchAt(alias: readonly string[], tokens: readonly string[]): number {
  if (alias.length === 0) return -1
  if (alias.length > 1) {
    for (let i = 0; i + alias.length <= tokens.length; i++) if (alias.every((w, j) => tokens[i + j] === w)) return i
    return -1
  }
  const word = alias[0]!
  if (word.length <= SHORT) return tokens[0] === word ? 0 : -1
  return tokens.indexOf(word)
}

/** The curated merchant domain a text names, or null. The longest alias wins, then the earliest. */
export function merchantAliasDomain(text: string | null | undefined): string | null {
  if (!text) return null
  const tokens = vendorTokens(text)
  if (tokens.length === 0) return null
  let best: { domain: string; words: number; letters: number; at: number } | null = null
  for (const alias of COMPILED) {
    const at = matchAt(alias.tokens, tokens)
    if (at < 0) continue
    const hit = { domain: alias.domain, words: alias.tokens.length, letters: alias.tokens.join('').length, at }
    if (
      !best ||
      hit.words > best.words ||
      (hit.words === best.words && (hit.letters > best.letters || (hit.letters === best.letters && hit.at < best.at)))
    ) {
      best = hit
    }
  }
  return best?.domain ?? null
}

/** The domain of the vendor the built-in marks' matcher reads in a text, or null. */
export function vendorKeyDomain(text: string | null | undefined): string | null {
  const key = vendorKeyFor(text)
  return key ? VENDOR_KEY_DOMAINS[key] : null
}

/** Every curated domain, for queueing them before any company names one. */
export function curatedDomains(): string[] {
  const all = [...Object.values(VENDOR_KEY_DOMAINS), ...MERCHANT_ALIASES.map((a) => a.domain)]
  return [...new Set(all.filter((d): d is string => !!d))]
}
