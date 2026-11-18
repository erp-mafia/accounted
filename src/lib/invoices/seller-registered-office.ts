import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { CompanySettings } from '@/types'

/**
 * The säte the seller's invoice documents print (crm#1604): the PDF footer
 * line and the invoice e-mail footer, next to the org.nr.
 *
 * Säte belongs to a legal person (aktiebolag, förening); a form whose org
 * number is the owner's personnummer (enskild firma) has none, the same rule
 * the settings form uses to show the field. Only the stored
 * `registered_office` prints, never the postal town (`city`): a company that
 * has not set its säte prints nothing rather than a guess.
 */
export function sellerRegisteredOffice(
  company: Pick<CompanySettings, 'entity_type' | 'registered_office'>,
): string | null {
  if (isEntityType(company.entity_type) && usesPersonnummerAsOrgNumber(company.entity_type)) return null
  const office = typeof company.registered_office === 'string' ? company.registered_office.trim() : ''
  return office || null
}
