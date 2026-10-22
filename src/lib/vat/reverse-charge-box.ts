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
 */
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import type { TransactionCategory } from '@/types'
import { sellerCountry, type SellerIdentity, type SellerRegion } from './seller-country'

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

/** The box a reverse-charge purchase in this category from a seller in this region reports, or why it cannot be told. */
export function reverseChargeBoxFor(region: SellerRegion | null, category: TransactionCategory): ReverseChargeBox {
  if (!region) return refuse('seller_country_unknown')
  if (region === 'se') return refuse('seller_in_sweden')
  const nature = CATEGORY_NATURE[category]
  if (!nature) return refuse('purchase_kind_unknown')
  if (nature === 'goods') return region === 'eu' ? { ok: true, kind: 'eu_goods' } : refuse('goods_from_outside_eu')
  return { ok: true, kind: region === 'eu' ? 'eu_services' : 'non_eu_services' }
}
