import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { isValidSwedishVatNumber, normalizeVatNumber } from '@/lib/vat/vat-number'
import { formatOrgNumber } from '@/lib/utils'

/**
 * The company's billing identity on its Stripe customer (PH 191).
 *
 * The person starting a subscription is logged in to a company we already
 * know: its legal name, organisationsnummer, momsregistreringsnummer and
 * address. Before this, the Stripe customer carried only the payer's email,
 * so Checkout asked the user to tick "I'm purchasing as a business" and type
 * the company's details again, and the receipt carried only what they typed.
 * Writing the identity onto the customer lets Checkout skip those fields
 * (Stripe hides tax ID collection for a customer that already has a tax ID)
 * and puts the details on every invoice and receipt Stripe issues.
 */
export interface CompanyBillingIdentity {
  /** Legal name: company_settings.company_name, falling back to companies.name. */
  name: string | null
  /** Full postal address, or null when street, postcode or city is missing. */
  address: Stripe.AddressParam | null
  /**
   * The stored momsregistreringsnummer of a momsregistrerad company, in the
   * canonical SE + 12 digits form. Never derived: a company that is not
   * registered, or registered without a stored number, gets none.
   */
  vatNumber: string | null
  /**
   * Organisationsnummer as NNNNNN-NNNN for a legal person. Null for an enskild
   * firma, whose number is the owner's personnummer and stays off the invoice.
   */
  orgNumber: string | null
}

interface CompanyRow {
  name: string | null
  org_number: string | null
  entity_type: string | null
}

interface SettingsRow {
  entity_type: string | null
  company_name: string | null
  org_number: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  vat_registered: boolean | null
  vat_number: string | null
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Pure mapping from the company rows to the identity Stripe gets. */
export function companyBillingIdentity(
  company: CompanyRow | null,
  settings: SettingsRow | null,
): CompanyBillingIdentity {
  const line1 = text(settings?.address_line1)
  const postalCode = text(settings?.postal_code)
  const city = text(settings?.city)
  const storedCountry = text(settings?.country)?.toUpperCase() ?? null
  const country = storedCountry && /^[A-Z]{2}$/.test(storedCountry) ? storedCountry : 'SE'
  const line2 = text(settings?.address_line2)
  const address: Stripe.AddressParam | null =
    line1 && postalCode && city
      ? { line1, ...(line2 ? { line2 } : {}), postal_code: postalCode, city, country }
      : null

  const storedVat = settings?.vat_number ? normalizeVatNumber(settings.vat_number) : null
  const vatNumber =
    settings?.vat_registered === true && storedVat && isValidSwedishVatNumber(storedVat) ? storedVat : null

  // An unknown legal form could be a sole trader, so it gets no org number.
  const entityType = company?.entity_type ?? settings?.entity_type ?? null
  const legalPerson = isEntityType(entityType) && !usesPersonnummerAsOrgNumber(entityType)
  const canonicalOrg = legalPerson ? normalizeOrgNumber(company?.org_number ?? settings?.org_number ?? null) : null

  return {
    name: text(settings?.company_name) ?? text(company?.name),
    address,
    vatNumber,
    orgNumber: canonicalOrg ? formatOrgNumber(canonicalOrg) : null,
  }
}

/** Reads the identity under the caller's client; throws on a failed read. */
export async function loadCompanyBillingIdentity(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
): Promise<CompanyBillingIdentity> {
  const [companyRes, settingsRes] = await Promise.all([
    db.from('companies').select('name, org_number, entity_type').eq('id', companyId).maybeSingle(),
    db
      .from('company_settings')
      .select('entity_type, company_name, org_number, address_line1, address_line2, postal_code, city, country, vat_registered, vat_number')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (companyRes.error) throw new Error(`companies lookup failed: ${companyRes.error.message}`)
  if (settingsRes.error) throw new Error(`company_settings lookup failed: ${settingsRes.error.message}`)
  return companyBillingIdentity(companyRes.data as CompanyRow | null, settingsRes.data as SettingsRow | null)
}

/** The customer fields the identity sets; empty when nothing is known. */
export function stripeCustomerIdentityFields(identity: CompanyBillingIdentity): Stripe.CustomerUpdateParams {
  return {
    ...(identity.name ? { name: identity.name, business_name: identity.name } : {}),
    // Validate the tax location now: an address Stripe Tax cannot place fails
    // here, where the caller falls back, instead of at Checkout.
    ...(identity.address ? { address: identity.address, tax: { validate_location: 'immediately' as const } } : {}),
    ...(identity.orgNumber
      ? { invoice_settings: { custom_fields: [{ name: 'Org.nr', value: identity.orgNumber }] } }
      : {}),
  }
}

export interface SyncedBillingIdentity {
  /** The customer has a tax ID, so Checkout shows no tax ID or business-name fields. */
  taxIdOnFile: boolean
  /** The customer holds the company's full address, so Checkout need not ask for it. */
  addressOnFile: boolean
  /** The customer holds the company's legal name. */
  nameOnFile: boolean
}

/** What Checkout assumes when nothing was prefilled: it collects everything itself. */
export const NOTHING_ON_FILE: SyncedBillingIdentity = Object.freeze({
  taxIdOnFile: false,
  addressOnFile: false,
  nameOnFile: false,
})

/**
 * Writes the identity onto the company's Stripe customer before Checkout.
 * An existing customer is updated, never recreated. The VAT number is added
 * as an eu_vat tax ID (Stripe's type for Swedish VAT numbers) only when the
 * customer has no tax ID yet, so one the payer entered earlier is kept and
 * no duplicate appears on the invoice.
 *
 * Throws on any Stripe error; the caller then opens Checkout as before.
 */
export async function syncStripeCustomerIdentity(
  stripe: Stripe,
  customerId: string,
  identity: CompanyBillingIdentity,
  opts: { justCreated: boolean },
): Promise<SyncedBillingIdentity> {
  const fields = stripeCustomerIdentityFields(identity)
  if (Object.keys(fields).length > 0) await stripe.customers.update(customerId, fields)

  let taxIdOnFile = false
  if (identity.vatNumber) {
    if (!opts.justCreated) {
      const existing = await stripe.customers.listTaxIds(customerId, { limit: 1 })
      taxIdOnFile = existing.data.length > 0
    }
    if (!taxIdOnFile) {
      await stripe.customers.createTaxId(customerId, { type: 'eu_vat', value: identity.vatNumber })
      taxIdOnFile = true
    }
  }

  return { taxIdOnFile, addressOnFile: identity.address !== null, nameOnFile: identity.name !== null }
}
