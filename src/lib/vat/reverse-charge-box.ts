/**
 * The momsdeklaration box of one reverse-charge purchase booked in bulk,
 * where one category and "omvänd skattskyldighet" are chosen for many
 * underlag at once (Inkorgen's "Bokför valda", the bulk_book_inbox_items
 * tool). The box is a property of each purchase, never of the batch: it turns
 * on where the seller is and on whether goods or a service was bought
 * (swedish-vat skill 2.1-2.5; SKV 4700 rutor 20-22):
 *
 *   - a service from another EU country: ruta 21 (basis 4535);
 *   - a service from a country outside the EU: ruta 22 (basis 4531);
 *   - goods from another EU country (unionsinternt förvärv): ruta 20 (basis 4515);
 *   - goods from a country outside the EU: import, whose VAT is reported in
 *     ruta 50/60 on the customs value, never as reverse charge;
 *   - a Swedish seller: omvänd betalningsskyldighet within Sweden (bygg-
 *     tjänster ruta 24, mobiltelefoner and datorer ruta 23), which nothing
 *     in a bulk choice can tell apart.
 *
 * When the box cannot be told, the purchase is left out with the reason,
 * never booked in ruta 21 by default: the person books it one at a time,
 * where the box is shown and picked. The seller's country is read the way
 * the Inkorg's one click reads it (./seller-country.ts), the supplier card
 * second.
 *
 * The single agent and API categorize (MCP gnubok_categorize_transaction,
 * v1 /transactions/{id}/categorize and its batch) follow the same rule for a
 * reverse charge sent without its box (#94): read off the bank row's
 * underlag, or refused with the question (reverseChargeBoxAsk). Nobody
 * there sees the box before it is booked.
 */
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import type { TransactionCategory } from '@/types'
import {
  regionOfCountry,
  sellerCountry,
  swedishVatNumberAbroad,
  type SellerCountrySource,
  type SellerIdentity,
  type SellerRegion,
} from './seller-country'
import { getCountryName } from './country-codes'
import { roundOre } from '@/lib/money'

/**
 * What a bank-booking category buys, for a seller abroad. Only the
 * categories whose purchases are plainly one or the other: travel and
 * representation are taxed where they take place, fees are exempt, and
 * office, vehicle, education and other costs can be either (see
 * ./purchase-category-vat-nature.ts for the finer inbox categories).
 */
const CATEGORY_NATURE: Partial<Record<TransactionCategory, 'service' | 'goods'>> = {
  expense_software: 'service',
  expense_telecom: 'service',
  // Advertising, the reverse-charge marketing purchase in practice.
  expense_marketing: 'service',
  expense_professional_services: 'service',
  expense_consumables: 'goods',
  expense_equipment: 'goods',
}

export type ReverseChargeBoxRefusal =
  | 'seller_country_unknown'
  | 'seller_in_sweden'
  | 'goods_from_outside_eu'
  | 'purchase_kind_unknown'
  | 'goods_under_swedish_vat_number'

export type ReverseChargeBox =
  | { ok: true; kind: ReverseChargeKind }
  | { ok: false; reason: ReverseChargeBoxRefusal; messageSv: string }

const REFUSAL_SV: Record<ReverseChargeBoxRefusal, string> = {
  seller_country_unknown:
    'Säljarens land går inte att läsa på underlaget, så rutan för omvänd moms (20, 21 eller 22) kan inte avgöras. Bokför underlaget för sig och välj rutan där.',
  seller_in_sweden:
    'Säljaren är svensk: omvänd skattskyldighet inom Sverige (byggtjänster ruta 24, viss elektronik ruta 23) bokförs ett underlag i taget. Står momsen på underlaget, välj momssatsen i stället.',
  goods_from_outside_eu:
    'Varor från ett land utanför EU är import: momsen redovisas på tullvärdet i ruta 50 och 60, inte som omvänd skattskyldighet. Bokför underlaget för sig.',
  purchase_kind_unknown:
    'Kategorin säger inte om köpet är en vara eller en tjänst (eller om omvänd skattskyldighet gäller alls), så rutan kan inte avgöras. Välj en mer precis kategori eller bokför underlaget för sig.',
  goods_under_swedish_vat_number:
    'Säljaren har ett svenskt momsnummer men adress utomlands, och köpet är varor. Underlaget visar inte om varorna skickats hit från ett annat EU-land (ruta 20), köpts i Sverige av en utländsk företagare (ruta 23) eller sålts med svensk moms. Bokför underlaget för sig och välj där.',
}

function refuse(reason: ReverseChargeBoxRefusal): ReverseChargeBox {
  return { ok: false, reason, messageSv: REFUSAL_SV[reason] }
}

/**
 * Where the seller is: the document's reading first (VAT number, IBAN,
 * organisationsnummer, address), then the supplier card's type when it says
 * abroad, as the supplier-invoice doors read it. A card's swedish_business is
 * no evidence (it is every new card's default, and its country column
 * defaults to SE), so it never decides. Null when nothing says.
 */
export function purchaseSellerRegion(
  reading: SellerIdentity | null | undefined,
  supplierType?: string | null,
): SellerRegion | null {
  const read = sellerCountry(reading)
  if (read.region) return read.region
  if (supplierType === 'eu_business') return 'eu'
  if (supplierType === 'non_eu_business') return 'non_eu'
  return null
}

/**
 * The box a reverse-charge purchase in this category from a seller in this
 * region reports, or why it cannot be told. sellers: what the purchase's
 * underlag read about its seller. Goods sold under a Swedish VAT number beside
 * an address abroad on any of them are boxed by no region, whether read, stated
 * for a service (confirmedAbroadRegion) or taken from a supplier card: an
 * unionsinternt förvärv (ruta 20) is goods sent here from another EU country
 * (ML 2023:200 5 kap. 22 §), and the invoice shows the number the goods were
 * supplied under (17 kap. 24 § p. 3), so they may as well have been bought in
 * Sweden (ruta 23) or sold with Swedish VAT. The person names the box.
 */
export function reverseChargeBoxFor(
  region: SellerRegion | null,
  category: TransactionCategory,
  sellers: ReadonlyArray<SellerIdentity | null | undefined> = [],
): ReverseChargeBox {
  if (CATEGORY_NATURE[category] === 'goods' && sellers.some((seller) => swedishVatNumberAbroad(seller))) {
    return refuse('goods_under_swedish_vat_number')
  }
  if (!region) return refuse('seller_country_unknown')
  if (region === 'se') return refuse('seller_in_sweden')
  const nature = CATEGORY_NATURE[category]
  if (!nature) return refuse('purchase_kind_unknown')
  if (nature === 'goods') return region === 'eu' ? { ok: true, kind: 'eu_goods' } : refuse('goods_from_outside_eu')
  return { ok: true, kind: region === 'eu' ? 'eu_services' : 'non_eu_services' }
}

/**
 * The region a Swedish VAT number beside an address abroad gives the box once
 * the caller has stated the seller is not established in Sweden for the sale
 * (confirm_foreign_seller_vat): the address's, for a service only. That
 * statement is about a service taxed here under the main rule (ML 2023:200
 * 16 kap. 4 and 9 §§); goods sold under a Swedish VAT number stay unboxed
 * (null), for the person to name.
 */
export function confirmedAbroadRegion(seller: SellerIdentity | null | undefined, category: TransactionCategory): SellerRegion | null {
  if (CATEGORY_NATURE[category] !== 'service') return null
  const country = swedishVatNumberAbroad(seller)
  return country ? regionOfCountry(country) : null
}

/** How a door names the box parameter: v1 takes reverse_charge_kind, the MCP tool vat_treatment variants. */
export type ReverseChargeBoxParam = 'reverse_charge_kind' | 'vat_treatment'

/** A staged reverse_charge_box_param read back at approval. */
export function isReverseChargeBoxParam(value: unknown): value is ReverseChargeBoxParam {
  return value === 'reverse_charge_kind' || value === 'vat_treatment'
}

const ASK_REASON: Record<ReverseChargeBoxRefusal, { sv: string; en: string }> = {
  seller_country_unknown: {
    sv: 'inget underlag till transaktionen visar säljarens land',
    en: "no underlag of the transaction names the seller's country",
  },
  seller_in_sweden: {
    sv: 'underlaget visar en svensk säljare, och omvänd skattskyldighet inom Sverige (ruta 23-24) bokförs inte med en kategori',
    en: 'the underlag shows a Swedish seller, and domestic reverse charge (boxes 23-24) is not booked by category',
  },
  goods_from_outside_eu: {
    sv: 'varor från ett land utanför EU är import, med momsen på tullvärdet i ruta 50 och 60',
    en: 'goods from outside the EU are an import, with the VAT on the customs value in boxes 50 and 60',
  },
  purchase_kind_unknown: {
    sv: 'kategorin säger inte om köpet är en vara eller en tjänst',
    en: 'the category does not say whether goods or a service was bought',
  },
  goods_under_swedish_vat_number: {
    sv: 'underlaget visar ett svenskt momsnummer med adress utomlands, och för varor visar det inte om de skickats hit från ett annat EU-land (ruta 20), köpts i Sverige av en utländsk företagare (ruta 23, bokförs inte med en kategori) eller sålts med svensk moms',
    en: 'the underlag shows a Swedish VAT number beside an address abroad, and for goods it does not show whether they were sent here from another EU country (box 20), bought in Sweden from a foreign business (box 23, not booked by category) or sold with Swedish VAT',
  },
}

const ASK_VALUES: Record<ReverseChargeBoxParam, { sv: string; en: string }> = {
  reverse_charge_kind: {
    sv: 'reverse_charge_kind "eu_services" (tjänst från ett annat EU-land, ruta 21), "non_eu_services" (tjänst från ett land utanför EU, ruta 22) eller "eu_goods" (varor från ett annat EU-land, ruta 20)',
    en: 'reverse_charge_kind "eu_services" (a service from another EU country, box 21), "non_eu_services" (a service from outside the EU, box 22) or "eu_goods" (goods from another EU country, box 20)',
  },
  vat_treatment: {
    sv: 'vat_treatment "reverse_charge_eu_services" (ruta 21), "reverse_charge_non_eu_services" (ruta 22) eller "reverse_charge_eu_goods" (ruta 20)',
    en: 'vat_treatment "reverse_charge_eu_services" (box 21), "reverse_charge_non_eu_services" (box 22) or "reverse_charge_eu_goods" (box 20)',
  },
}

/** The single door's refusal: why the box cannot be told, and how to name it. */
export function reverseChargeBoxAsk(reason: ReverseChargeBoxRefusal, param: ReverseChargeBoxParam): { sv: string; en: string } {
  const why = ASK_REASON[reason]
  const values = ASK_VALUES[param]
  return {
    sv: `Rutan för omvänd skattskyldighet kan inte avgöras: ${why.sv}. Ange den med ${values.sv}, eller bokför utan omvänd skattskyldighet om köpet inte är det.`,
    en: `The reverse-charge box cannot be told: ${why.en}. Name it with ${values.en}, or book without reverse charge if the purchase is not one.`,
  }
}

/** What a document reading says about its VAT, as far as the seller's charge goes (the extraction's shape fits). */
export interface ChargedVatReading {
  totals?: { vatAmount?: unknown } | null
  vatBreakdown?: unknown
}

/**
 * The VAT the seller charged on the document, as its reading states it: the
 * breakdown's charged groups, else the total's VAT; 0 when it shows none.
 * Omvänd skattskyldighet covers only a purchase the seller charged no VAT on,
 * so a reverse charge booked in bulk skips an underlag that shows a charge,
 * as the Inkorg's one click sends it to the editor (#94).
 */
export function sellerChargedVat(reading: ChargedVatReading | null | undefined): number {
  const groups = Array.isArray(reading?.vatBreakdown) ? (reading.vatBreakdown as Array<{ amount?: unknown }>) : []
  const charged = groups.map((group) => Number(group?.amount)).filter((amount) => Number.isFinite(amount) && amount > 0)
  if (charged.length > 0) return roundOre(charged.reduce((sum, amount) => sum + amount, 0))
  const total = Number(reading?.totals?.vatAmount)
  return Number.isFinite(total) && total > 0 ? roundOre(total) : 0
}

/**
 * The caller's explicit word, on a categorize door, that the VAT the underlag
 * shows is another country's VAT the seller charged in error (crm#1765). The
 * purchase is then still the buyer's to tax in Sweden (ML 2023:200 16 kap.
 * 9 §), on everything the seller was paid, the foreign VAT included (8 kap.
 * 2, 3 and 13 §§), and that VAT is never ingående moms (13 kap. 4 §, 2 kap.
 * 12 §).
 */
export const FOREIGN_SELLER_VAT_FLAG = 'confirm_foreign_seller_vat'

/**
 * What the approver and the agent are told on a booking made under the flag:
 * the charge is foreign VAT, or Swedish VAT a seller not established here
 * charged in error (2 kap. 12 §), and neither is ingående moms.
 */
export const FOREIGN_SELLER_VAT_NOTE = {
  sv: 'Momsen som säljaren debiterat är inte avdragsgill i Sverige: den ingår i kostnaden och i underlaget för den omvända momsen. Be säljaren om en kreditfaktura på momsen och ge dem ert momsregistreringsnummer (VAT-nummer).',
  en: 'The VAT the seller charged is not deductible in Sweden: it is part of the cost and of the reverse-charge basis. Ask the seller for a credit note for the VAT and give them your VAT number.',
} as const

/**
 * Added when the seller's VAT number is Swedish and its address is abroad:
 * the approver reads what the caller has stated (ML 2023:200 16 kap. 4 §).
 */
export function swedishVatNumberAbroadNote(addressCountry: string): { sv: string; en: string } {
  return {
    sv: `Säljaren har ett svenskt momsnummer men adress i ${getCountryName(addressCountry, 'sv')}: bokfört på uppgiften att säljaren inte är etablerad i Sverige för den här försäljningen.`,
    en: `The seller has a Swedish VAT number but an address in ${getCountryName(addressCountry, 'en')}: booked on the statement that the seller is not established in Sweden for this sale.`,
  }
}

/** Added when the charge is 25 % of the price, the Swedish rate: the document cannot tell whose VAT it is. */
export const FOREIGN_SELLER_VAT_RATE_WARNING = {
  sv: 'Momsen på underlaget är 25 % av priset, samma sats som svensk moms. Kontrollera att det är utländsk moms: svensk moms bokförs med momssatsen som ingående moms, inte med omvänd skattskyldighet.',
  en: 'The VAT on the underlag is 25 % of the price, the Swedish rate. Check that it is foreign VAT: Swedish VAT is booked at its rate as input VAT, not as reverse charge.',
} as const

export type SellerVatOnReverseCharge =
  /** The underlag shows no charge: a plain reverse charge. */
  | { verdict: 'no_seller_vat' }
  /** The document names a Swedish seller, so the charge is Swedish VAT: refused whatever the caller states. */
  | { verdict: 'refused'; reason: 'seller_vat_swedish'; source: SellerCountrySource | null }
  /**
   * A charge nobody has stated to be foreign: refused, and the refusal names
   * the flag. addressCountry: the document's VAT number is Swedish and its
   * address names this country (swedishVatNumberAbroad), so the question is
   * whether the seller is established in Sweden for the sale.
   */
  | { verdict: 'refused'; reason: 'not_confirmed'; addressCountry: string | null }
  /** Stated foreign and nothing on the document says otherwise. */
  | { verdict: 'confirmed'; couldBeSwedishVat: boolean }

/** Whether a charge is the Swedish standard rate of the price before it (half a percentage point either way). */
function isSwedishStandardRate(sellerVat: number, total: number | null | undefined): boolean {
  const net = typeof total === 'number' && Number.isFinite(total) ? total - sellerVat : 0
  // No total to measure against: the rate cannot be told, so it is not ruled out.
  if (!(net > 0)) return true
  return Math.abs(sellerVat / net - 0.25) <= 0.005
}

/**
 * A reverse charge asked for on an underlag whose reading shows the seller's
 * VAT. Refused by default; allowed when the caller confirms the VAT is
 * foreign (FOREIGN_SELLER_VAT_FLAG), unless the document itself names a
 * Swedish seller (a VAT number that starts with SE first, then the other
 * sources of ./seller-country.ts): Swedish VAT on an invoice is ordinary
 * ingående moms and never turns into a reverse charge on a caller's word.
 *
 * A Swedish VAT number beside an address abroad names no seller as Swedish
 * (./seller-country.ts swedishVatNumberAbroad). The caller's word is then
 * that the seller is not established in Sweden for the sale (ML 2023:200
 * 16 kap. 4 §): the buyer owes the VAT (16 kap. 9 §) and the charge is
 * felaktigt debiterad (2 kap. 12 §), never ingående moms (13 kap. 4 §). The
 * warning that 25 % could be Swedish VAT is not given then: the document says
 * Swedish VAT itself, and the caller has answered why it is not deducted.
 */
export function sellerVatOnReverseCharge(reading: {
  sellerVat: number | null | undefined
  total?: number | null
  seller?: SellerIdentity | null
  confirmedForeign: boolean
}): SellerVatOnReverseCharge {
  const sellerVat = reading.sellerVat ?? 0
  if (!(sellerVat > 0)) return { verdict: 'no_seller_vat' }
  const seller = sellerCountry(reading.seller)
  if (seller.region === 'se') return { verdict: 'refused', reason: 'seller_vat_swedish', source: seller.source }
  const addressCountry = swedishVatNumberAbroad(reading.seller)
  if (!reading.confirmedForeign) return { verdict: 'refused', reason: 'not_confirmed', addressCountry }
  return { verdict: 'confirmed', couldBeSwedishVat: addressCountry === null && isSwedishStandardRate(sellerVat, reading.total) }
}

/**
 * The refusal's own words, in both locales, for the two reasons; with
 * addressCountry (a Swedish VAT number beside an address abroad), the
 * question of where the seller is established.
 */
export function sellerVatRefusalMessage(
  reason: 'seller_vat_swedish' | 'not_confirmed',
  charged: string,
  addressCountry: string | null = null,
): { sv: string; en: string } {
  if (reason === 'not_confirmed' && addressCountry) {
    return {
      sv:
        `Omvänd skattskyldighet avvisas tills den bekräftas: säljaren har ett svenskt momsnummer men adressen på underlaget är i ` +
        `${getCountryName(addressCountry, 'sv')}, och säljaren har debiterat moms (${charged}). Är köpet en tjänst som beskattas i Sverige ` +
        `enligt huvudregeln och säljaren inte etablerad i Sverige för försäljningen, är det köparen som redovisar momsen och momsen ` +
        `på fakturan är felaktigt debiterad och dras inte av: ` +
        `skicka då igen med ${FOREIGN_SELLER_VAT_FLAG}=true. Deltar säljarens etablering i Sverige i försäljningen, bokför med momssatsen (standard_25) i stället.`,
      en:
        `Reverse charge refused until confirmed: the seller has a Swedish VAT number but the underlag's address is in ` +
        `${getCountryName(addressCountry, 'en')}, and the seller charged VAT (${charged}). If the purchase is a service taxed in Sweden ` +
        `under the main rule and the seller is not established in Sweden for the sale, the buyer accounts for the VAT, and the VAT ` +
        `on the invoice was charged in error and is not deducted: ` +
        `resend with ${FOREIGN_SELLER_VAT_FLAG}=true. If the seller's establishment in Sweden takes part in the sale, book it at its rate (standard_25) instead.`,
    }
  }
  if (reason === 'seller_vat_swedish') {
    return {
      sv:
        `Omvänd skattskyldighet avvisas: underlaget visar en svensk säljare som har debiterat moms (${charged}). Det är svensk moms: ` +
        `bokför med momssatsen (till exempel standard_25), då dras den av som ingående moms. ${FOREIGN_SELLER_VAT_FLAG} gäller bara utländsk moms.`,
      en:
        `Reverse charge refused: the underlag shows a Swedish seller that charged VAT (${charged}). That is Swedish VAT: ` +
        `book it at its rate (for example standard_25) and it is deducted as input VAT. ${FOREIGN_SELLER_VAT_FLAG} only covers foreign VAT.`,
    }
  }
  return {
    sv:
      `Omvänd skattskyldighet avvisas: underlaget visar att säljaren har debiterat moms (${charged}). Är det utländsk moms som säljaren ` +
      `debiterat felaktigt, skicka igen med ${FOREIGN_SELLER_VAT_FLAG}=true: köpet bokförs då med omvänd skattskyldighet på hela det betalda ` +
      'beloppet, den utländska momsen inräknad, och den momsen dras inte av. Är det svensk moms, bokför med momssatsen (standard_25) i stället.',
    en:
      `Reverse charge refused: the underlag shows the seller charged VAT (${charged}). If it is foreign VAT the seller charged in error, ` +
      `resend with ${FOREIGN_SELLER_VAT_FLAG}=true: the purchase is then booked as reverse charge on the whole amount paid, the foreign VAT ` +
      'included, and that VAT is not deducted. If it is Swedish VAT, book it at its rate (standard_25) instead.',
  }
}
