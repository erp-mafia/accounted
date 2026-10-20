/**
 * What kind of supply each purchase category (lib/categories/purchase-categories.ts)
 * is, for the VAT of a purchase from a seller abroad:
 *
 *   - service: a service to a business, taxed where the buyer is (ML 6 kap
 *     33 §, the main rule): bought from abroad without VAT it is omvänd
 *     betalningsskyldighet, basis in ruta 21 (EU) or 22 (outside the EU);
 *   - goods: goods (an unionsinternt förvärv, an import), never booked as a
 *     service;
 *   - exception: a service taxed somewhere else than at the buyer, or
 *     exempt (ML 6 kap 38, 39, 46, 48 and 52 §§: services connected to real
 *     estate, passenger transport, admission to events, restaurant and
 *     catering, short-term hire of a means of transport; plus insurance,
 *     financial services, health care and fees to authorities, which carry
 *     no VAT at all): a foreign seller's VAT on these is that country's;
 *   - unknown: unclear from the category alone (printing, repairs, training,
 *     equipment hire ...).
 *
 * Conservative on purpose: anything unclear is unknown, and only `service`
 * is ever booked with reverse charge by the Inkorg's one click
 * (lib/inkorg/one-click.ts); everything else from abroad opens the editor.
 * A seller in Sweden is unaffected: its invoice states the Swedish VAT.
 *
 * Complete by type: a new category code does not compile until it has a
 * nature here.
 */
import type { PurchaseCategoryCode } from '@/lib/categories/purchase-categories'

export type PurchaseVatNature = 'service' | 'goods' | 'exception' | 'unknown'

export const PURCHASE_CATEGORY_VAT_NATURE: Readonly<Record<PurchaseCategoryCode, PurchaseVatNature>> = Object.freeze({
  'expense.software.saas': 'service',
  'expense.software.licence': 'service',
  'expense.software.cloud_hosting': 'service',
  'expense.software.domains': 'service',
  'expense.software.services': 'service',

  'expense.telecom.mobile': 'service',
  'expense.telecom.landline': 'service',
  'expense.telecom.internet': 'service',

  'expense.office.supplies': 'goods',
  // Printed matter is goods, a print job a service: unclear.
  'expense.office.printing': 'unknown',
  // A universal postal service is exempt; a courier is not.
  'expense.office.postage': 'unknown',

  // Connected to real estate (ML 6 kap 38 §).
  'expense.premises.rent': 'exception',
  // Electricity, gas and heating are supplied as goods.
  'expense.premises.electricity': 'goods',
  'expense.premises.heating': 'goods',
  'expense.premises.water': 'goods',
  'expense.premises.cleaning': 'exception',
  'expense.premises.repairs': 'exception',
  'expense.premises.alarm': 'exception',

  'expense.equipment.hardware': 'goods',
  'expense.equipment.furniture': 'goods',
  'expense.equipment.tools': 'goods',
  'expense.equipment.machinery': 'goods',
  // Hire of movable goods: a vehicle in it is short-term hire of a means of transport.
  'expense.equipment.rental': 'unknown',
  'expense.equipment.repairs': 'unknown',

  'expense.consumables.operating_supplies': 'goods',

  'expense.vehicle.fuel': 'goods',
  // Letting a parking space is connected to real estate.
  'expense.vehicle.parking': 'exception',
  'expense.vehicle.repairs': 'unknown',
  'expense.vehicle.leasing': 'unknown',
  // Insurance is exempt; vehicle tax is no supply.
  'expense.vehicle.insurance_tax': 'exception',
  'expense.vehicle.congestion_tax': 'exception',
  'expense.vehicle.accessories': 'goods',

  // Passenger transport (ML 6 kap 39 §).
  'expense.travel.flight': 'exception',
  'expense.travel.train': 'exception',
  'expense.travel.taxi': 'exception',
  // Accommodation is connected to real estate (38 §), a car hired short-term is 52 §, a meal is 48 §.
  'expense.travel.hotel': 'exception',
  'expense.travel.car_rental': 'exception',
  'expense.travel.meals': 'exception',
  'expense.travel.other': 'unknown',

  // Restaurant, catering and events.
  'expense.representation.client': 'exception',
  'expense.representation.staff': 'exception',

  'expense.marketing.ads': 'service',
  'expense.marketing.print': 'unknown',
  // Admission to an event (ML 6 kap 46 §).
  'expense.marketing.events': 'exception',
  'expense.marketing.gifts': 'goods',
  'expense.marketing.sponsorship': 'unknown',
  'expense.marketing.agency': 'service',

  'expense.professional_services.accounting': 'service',
  'expense.professional_services.audit': 'service',
  'expense.professional_services.legal': 'service',
  'expense.professional_services.tax_advice': 'service',
  'expense.professional_services.consulting': 'service',
  // An architect's or engineer's work on a property is connected to real estate.
  'expense.professional_services.technical': 'unknown',
  'expense.professional_services.staffing': 'service',

  'expense.goods.resale': 'goods',
  'expense.goods.materials': 'goods',
  // Often construction work on a property.
  'expense.goods.subcontracting': 'unknown',
  'expense.goods.packaging': 'goods',
  'expense.goods.freight': 'service',
  'expense.goods.customs': 'exception',

  // Health care is exempt; access to sports facilities is admission.
  'expense.personnel.health': 'exception',
  'expense.personnel.wellness': 'exception',
  'expense.personnel.recruitment': 'service',
  'expense.personnel.workwear': 'goods',
  'expense.personnel.gifts': 'goods',
  'expense.personnel.refreshments': 'goods',

  // A course attended in person is admission to an event; an online one is a service.
  'expense.education.training': 'unknown',
  'expense.education.literature': 'unknown',

  // Insurance and financial services are exempt.
  'expense.insurance.business': 'exception',
  'expense.insurance.credit': 'exception',
  'expense.insurance.deductible': 'exception',

  'expense.bank_fees.fees': 'exception',
  'expense.bank_fees.factoring': 'exception',

  'expense.card_fees.payment_fees': 'exception',

  'expense.fees.authorities': 'exception',
  'expense.fees.memberships': 'unknown',
  'expense.fees.collection': 'unknown',
  'expense.fees.royalties': 'service',
  'expense.fees.patents_trademarks': 'unknown',
})

export function purchaseVatNature(code: PurchaseCategoryCode): PurchaseVatNature {
  return PURCHASE_CATEGORY_VAT_NATURE[code] ?? 'unknown'
}
