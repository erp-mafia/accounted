import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'

/**
 * Pre-classifier for counterparty keys: routes a key before entity
 * resolution. Deterministic rules only; scored against the founder-labelled
 * golden set on 2026-09-02 at 0.965 agreement (party recall 0.99, non-party
 * recall 0.93) on 180 held-out keys, see scripts/parties/README.md.
 *
 * Label vocabulary (settled with the founder 2026-09-02):
 * - party: a real counterpart. AP prefixes always mean party. A marketplace or
 *   processor the company actually pays is a party; a card-platform line
 *   with an employee's name is a party; insurance premiums are parties.
 * - category: an expense description with no counterpart in it.
 * - payroll: salary, benefits, expense claims to a person.
 * - adjustment: periodisering, omföring, lagerförändring, nedskrivning, rättelse.
 * - authority: a state fee or tax where the counterpart is fixed.
 * - bank: bank fees and bank products.
 * - intermediary: a rail carrying someone else's money (Klarna, Swish, Zettle payouts).
 * - unsure: nothing to decide on.
 */
export const PARTY_LABELS = ['party', 'category', 'payroll', 'adjustment', 'authority', 'bank', 'intermediary', 'unsure'] as const
export type PartyLabel = (typeof PARTY_LABELS)[number]

const STOP = new Set([
  'av', 'och', 'för', 'via', 'kort', 'ej', 'moms', 'inkl', 'exkl', 'per', 'utanför', 'inom', 'eu', 'se', 'ab',
  'till', 'mot', 'med', 'från', 'på', 'i', 'en', 'ett', 'den', 'det', 'som', 'om', 'utan', 'the', 'usd', 'eur', 'sek',
])

// Generic words voucher text uses for a category without a counterpart.
// Geographic tokens are deliberately absent: "taxi stockholm" reads as a party
// to the founder, "taxiresor och parkering" does not.
const GENERIC = [
  'inköp', 'inkp', 'kvitto', 'kvitton', 'fika', 'diesel', 'bensin', 'bränsle', 'försäkring', 'telefon', 'mobil', 'hyra',
  'lokalhyra', 'frakt', 'hosting', 'julklapp', 'frimärken', 'utlägg', 'hotell', 'resa', 'resor', 'resekostnader',
  'registreringsavgift', 'registeringsavgift', 'tillsynsavgift', 'årsavgift', 'medlemsavgift', 'serviceavgift', 'anmälningsavgift', 'expeditionsavgift',
  'biljett', 'biljetter', 'biljettkostnad', 'taxi', 'taxiresor', 'parkering', 'parkeringsavgifter', 'representation',
  'måltidsrepresentation', 'kollektivtrafik', 'kollektivtra', 'kontorsmaterial', 'förbrukning', 'förbrukningsmateriel',
  'frbrukningsmateriel', 'programvara', 'mjukvara', 'licens', 'avgift', 'avgifter', 'traktamente', 'traktamenten',
  'bilersättning', 'material', 'varor', 'tjänster', 'tjnster', 'faktura', 'kostnad', 'kostnader', 'betalning', 'utgift',
  'företagskvitto', 'fretagskvitto', 'fretagskvitton', 'övriga', 'personbilskostnader', 'glykol', 'lastbil', 'verktyg',
  'abonnemang', 'subscription', 'ittjänster', 'itprodukter', 'inrikes', 'utrikes', 'utlandsk', 'utländsk', 'europeisk',
  'annonsering', 'konsultarvoden', 'momspliktig', 'momsfri', 'skattefritt', 'utomlands', 'internet', 'överföring',
  'kortköputtag', 'kortkp', 'uttag', 'avdragsgill', 'avdragbar', 'schablon', 'person', 'deltagare', 'syfte', 'möte',
  'samarbete', 'rapporterad', 'kundfaktura', 'påminnelseavgifter', 'avräkningsnota', 'avrkningsnota', 'fakturaservice',
  'påminnelse', 'ränta', 'dröjsmålsränta', 'porto', 'kontor', 'lokal', 'el', 'vatten', 'värme', 'städning', 'reparation',
  'underhåll', 'service', 'utbildning', 'kurs', 'litteratur', 'tidningar', 'bok', 'böcker', 'gåva', 'gåvor', 'mat',
  'lunch', 'middag', 'kaffe', 'personal', 'friskvård', 'sjukvård', 'arbetskläder', 'skyddskläder',
]

// BAS account NAMES only. Descriptions name example vendors (Google,
// Facebook) and would make real parties look generic, the trap the July
// design found.
let vocabCache: Set<string> | null = null
function vocab(): Set<string> {
  if (vocabCache) return vocabCache
  const v = new Set<string>(GENERIC)
  for (const a of BAS_REFERENCE) {
    if (a.account_class < 4) continue
    for (const t of a.account_name.toLowerCase().split(/[^a-zåäöé]+/)) if (t.length >= 3) v.add(t)
  }
  vocabCache = v
  return v
}

const AP_PREFIX = /^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura|leverantorsfaktura|levbet\.?|lev\.?bet\.?)\b/
const PAYROLL = /\b(lön|löner|löne\w*|lneutbetalning|lönebesked|salary|semesterskuld|arbetsgivaravgift\w*)\b/
const ADJUSTMENT =
  /(periodisering|omföring|omforing|lagerförändring|lagerforandring|nedskrivning|rättelse|rattelse|kostnadsföring|avskrivning|bokslut|kursdiff|valutakurs|eur till sek|omvänd betalningsskyldighet)/
const BANK = /(bankkostnad|bankavgift|banktjänst|baspaket bank|bank årsavg|årsavg|avi överdrag|företagspaket)/
const AUTHORITY = /\b(skatteverket|bolagsverket|transportstyrelsen|försäkringskassan|kronofogden|tullverket|skattekonto|finansinspektionen|arbetsförmedlingen|pensionsmyndigheten|migrationsverket|lantmäteriet|csn|polisen|domstol|tingsrätt|förvaltningsrätt)\b/
const INTERMEDIARY = /\b(klarna|paypal|zettle|izettle|swish|payex|bankgirot|adyen|nets)\b/

function acctNum(a: string | null | undefined): number {
  const n = Number(a)
  return Number.isFinite(n) ? n : 0
}

/**
 * Classify a normalised counterparty key. `acct` is the dominant result
 * account of the key's vouchers, used only to catch payroll booked on
 * 70xx-72xx without a telling word in the text.
 */
export function classifyKey(input: { key: string; acct?: string | null }): PartyLabel {
  const k = input.key.toLowerCase().trim()
  if (!k) return 'unsure'
  const acct = acctNum(input.acct)
  if (AP_PREFIX.test(k)) return 'party'
  if (PAYROLL.test(k) || (acct >= 7010 && acct <= 7299)) return 'payroll'
  if (ADJUSTMENT.test(k)) return 'adjustment'
  if (BANK.test(k)) return 'bank'
  if (AUTHORITY.test(k)) return 'authority'
  if (INTERMEDIARY.test(k)) return 'intermediary'
  const content = k
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^k\d+$/.test(t) && !STOP.has(t))
  if (content.length === 0) return 'unsure'
  const v = vocab()
  return content.every((t) => v.has(t)) ? 'category' : 'party'
}
