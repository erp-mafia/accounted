import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { effectiveOrgNumber } from '@/lib/company/org-number'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { isValidSwedishVatNumber, normalizeVatNumber } from '@/lib/vat/vat-number'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { getStripe } from './client'

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
 *
 * The customer is a copy of what the company holds in Accounted, so it is
 * written again whenever that may have moved (crm#1378): at checkout, when
 * a settings save changes one of the identity columns, and on every
 * subscription event of a paying company. A renewal sends one while its
 * invoice is still a draft, and a draft invoice takes the customer's name,
 * address and tax IDs as they are when it is finalized, so the renewal
 * carries the current identity even for a customer that subscribed before
 * the prefill existed.
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
  const canonicalOrg = legalPerson ? normalizeOrgNumber(effectiveOrgNumber(settings?.org_number, company?.org_number)) : null

  return {
    name: text(settings?.company_name) ?? text(company?.name),
    address,
    vatNumber,
    orgNumber: canonicalOrg ? formatOrgNumberDisplay(canonicalOrg) : null,
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
  /**
   * The tax ID value the customer carries (ours, or one the payer entered
   * earlier), when known. Null when none was looked up or added.
   */
  taxId: string | null
}

/** What Checkout assumes when nothing was prefilled: it collects everything itself. */
export const NOTHING_ON_FILE: SyncedBillingIdentity = Object.freeze({
  taxIdOnFile: false,
  addressOnFile: false,
  nameOnFile: false,
  taxId: null,
})

/**
 * Writes the identity onto the company's Stripe customer: before Checkout,
 * and again at every later sync (syncCompanyStripeIdentity below). An
 * existing customer is updated, never recreated. The VAT number is added
 * as an eu_vat tax ID (Stripe's type for Swedish VAT numbers) only when the
 * customer has no tax ID yet, so one the payer entered earlier is kept and
 * no duplicate appears on the invoice.
 *
 * Throws on any Stripe error; Checkout then opens as before, and a later
 * sync tries again.
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
  let taxId: string | null = null
  if (identity.vatNumber) {
    if (!opts.justCreated) {
      const existing = await stripe.customers.listTaxIds(customerId, { limit: 1 })
      taxIdOnFile = existing.data.length > 0
      taxId = existing.data[0]?.value ?? null
    }
    if (!taxIdOnFile) {
      // Keyed: a renewal and a checkout send several subscription events at
      // once, and two syncs that both found no tax ID must add one, not two.
      await stripe.customers.createTaxId(
        customerId,
        { type: 'eu_vat', value: identity.vatNumber },
        { idempotencyKey: `customer-tax-id:${customerId}:${identity.vatNumber}` },
      )
      taxIdOnFile = true
      taxId = identity.vatNumber
    }
  }

  return { taxIdOnFile, addressOnFile: identity.address !== null, nameOnFile: identity.name !== null, taxId }
}

/** Stripe's ceiling for a Checkout custom_text message. */
const CHECKOUT_TEXT_MAX = 1200

/**
 * The sentence Checkout shows beside the pay button when the company's
 * identity is already on the Stripe customer.
 *
 * With the identity prefilled, Stripe hides tax ID collection (it never
 * shows a customer's saved tax IDs) and Checkout keeps the name, so the page
 * shows no company at all: a payer reported that Checkout "does not let me
 * enter company details or VAT ID" for a company whose name, org number, VAT
 * number and address were on the customer (agent feedback 2026-11-02). This
 * says what the invoice will carry and where to change it. Only what the sync
 * actually wrote is listed; null when there is no name on file, in which
 * case Checkout collects the details itself.
 */
export function checkoutIdentityNotice(
  identity: CompanyBillingIdentity,
  synced: SyncedBillingIdentity,
  locale: 'sv' | 'en',
): string | null {
  if (!synced.nameOnFile || !identity.name) return null
  const sv = locale === 'sv'
  const parts = [identity.name]
  if (identity.orgNumber) parts.push(`${sv ? 'org.nr' : 'org. no.'} ${identity.orgNumber}`)
  if (synced.taxId) parts.push(`${sv ? 'momsreg.nr' : 'VAT no.'} ${synced.taxId}`)
  if (synced.addressOnFile && identity.address) {
    const a = identity.address
    parts.push([a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', '))
  }
  const message = sv
    ? `Fakturan ställs ut på ${parts.join(', ')}. Stämmer något inte? Ändra under Inställningar > Företag > Allmänt och starta betalningen igen.`
    : `The invoice is issued to ${parts.join(', ')}. Anything wrong? Change it under Settings > Company > General and start the payment again.`
  return message.length > CHECKOUT_TEXT_MAX ? `${message.slice(0, CHECKOUT_TEXT_MAX - 3)}...` : message
}

/**
 * The company_settings columns the identity is read from. A save that
 * changes none of them leaves the Stripe customer as it is.
 */
export const BILLING_IDENTITY_COLUMNS = [
  'entity_type',
  'company_name',
  'org_number',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'country',
  'vat_registered',
  'vat_number',
] as const

/** Whether a settings save moved anything the Stripe customer carries. */
export function billingIdentityChanged(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  return BILLING_IDENTITY_COLUMNS.some((column) => (before?.[column] ?? null) !== (after?.[column] ?? null))
}

/**
 * Writes the company's current identity onto its existing Stripe customer
 * (crm#1378): the one function every later moment calls (a settings save,
 * a subscription event). Pass the customer id when the caller has it;
 * otherwise it is read from company_subscriptions. A company that never
 * reached checkout has no customer: null, and Stripe is not asked.
 *
 * Throws on a failed read or any Stripe error; every caller treats the sync
 * as best effort, since the next save or subscription event writes it again.
 */
export async function syncCompanyStripeIdentity(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  opts: { stripe?: Stripe; customerId?: string | null } = {},
): Promise<SyncedBillingIdentity | null> {
  let customerId = opts.customerId ?? null
  if (!customerId) {
    const { data, error } = await db
      .from('company_subscriptions')
      .select('stripe_customer_id')
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`company_subscriptions lookup failed: ${error.message}`)
    customerId = (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null
  }
  if (!customerId) return null

  const identity = await loadCompanyBillingIdentity(db, companyId)
  return syncStripeCustomerIdentity(opts.stripe ?? getStripe(), customerId, identity, { justCreated: false })
}
