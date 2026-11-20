import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The columns a provider register can fill on a card that already exists.
 *
 * A key left out (undefined) is a column the caller did not read: it is never
 * filled. NULL is the only "never configured" value.
 */
interface ExistingPartyDetails {
  email?: string | null
  phone?: string | null
  address_line1?: string | null
  address_line2?: string | null
  postal_code?: string | null
  city?: string | null
  country?: string | null
  vat_number?: string | null
  notes?: string | null
}

export interface ExistingCustomerMetadata extends ExistingPartyDetails {
  contact_person: string | null
  invoice_email_cc_addresses: string[] | null
  invoice_email_bcc_addresses: string[] | null
  /**
   * NULL on a row the invoice steps created as a minimal stub for a
   * counterparty the register never delivered; the register row that later
   * maps onto it by name brings the number.
   */
  org_number?: string | null
  /**
   * An individual (privatperson) never learns an org number from a provider
   * record matched to it by name: it has none, and its personnummer lives
   * encrypted in personal_number.
   */
  customer_type?: string | null
  /** The kundnummer; a matched card without one gets the provider's (crm#1744). */
  customer_number?: string | null
}

export interface ExistingSupplierDetails extends ExistingPartyDetails {
  /** Left out by a caller that fills the org number its own way. */
  org_number?: string | null
  bankgiro?: string | null
  plusgiro?: string | null
  /** The legacy free-text account an earlier import wrote; read, never filled. */
  bank_account?: string | null
  clearing_number?: string | null
  account_number?: string | null
  iban?: string | null
  bic?: string | null
  /** The default account; filled only with one the mapped row vetted against the chart (crm#1744). */
  default_expense_account?: string | null
}

/**
 * Keys restricted to real columns so callers can spell the update payload as
 * an object literal (absent keys stay undefined and are dropped at
 * serialization, leaving those columns untouched).
 */
interface PartyDetailsEnrichment {
  email?: string
  phone?: string
  address_line1?: string
  address_line2?: string
  postal_code?: string
  city?: string
  country?: string
  vat_number?: string
  notes?: string
}

export interface CustomerMetadataEnrichment extends PartyDetailsEnrichment {
  contact_person?: string
  invoice_email_cc_addresses?: string[]
  invoice_email_bcc_addresses?: string[]
  org_number?: string
  customer_number?: string
}

export interface SupplierEnrichment extends PartyDetailsEnrichment {
  org_number?: string
  bankgiro?: string
  plusgiro?: string
  clearing_number?: string
  account_number?: string
  iban?: string
  bic?: string
  default_expense_account?: string
}

const ADDRESS_COLUMNS = ['address_line1', 'address_line2', 'postal_code', 'city'] as const
const SINGLE_COLUMNS = ['email', 'phone', 'country', 'vat_number', 'notes'] as const
const SUPPLIER_COLUMNS = ['org_number', 'bankgiro', 'plusgiro', 'iban', 'bic', 'default_expense_account'] as const

/** A real provider value: an empty or blank string is no value. */
function providerText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function emailList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((x): x is string => typeof x === 'string')
    ? value
    : undefined
}

/**
 * The contact columns a matched card is missing (crm#1436): a card the
 * register matches to (an invoice stub, an earlier import, a hand-made card)
 * gets what a new card would have had, where it has nothing. The postal
 * address is one block, filled only on a card with no part of an address, so
 * a city the user typed is never paired with the provider's street.
 */
function partyDetailsEnrichment(
  existing: ExistingPartyDetails,
  mapped: Record<string, unknown>,
): PartyDetailsEnrichment {
  const changes: PartyDetailsEnrichment = {}
  for (const column of SINGLE_COLUMNS) {
    const value = providerText(mapped[column])
    if (existing[column] === null && value !== undefined) changes[column] = value
  }
  if (ADDRESS_COLUMNS.every((column) => existing[column] === null)) {
    for (const column of ADDRESS_COLUMNS) {
      const value = providerText(mapped[column])
      if (value !== undefined) changes[column] = value
    }
  }
  return changes
}

/**
 * Build a provider-migration enrichment without overwriting user choices.
 *
 * NULL is the only "never configured" value. Empty strings/arrays are explicit
 * clears, so a later migration rerun leaves them alone. The mapped row must
 * also contain real metadata: converting NULL to an empty value is not useful.
 */
export function buildCustomerMetadataEnrichment(
  existing: ExistingCustomerMetadata,
  mapped: Record<string, unknown>,
): CustomerMetadataEnrichment | null {
  const changes: CustomerMetadataEnrichment = partyDetailsEnrichment(existing, mapped)
  const contactPerson = providerText(mapped.contact_person)
  const cc = emailList(mapped.invoice_email_cc_addresses)
  const bcc = emailList(mapped.invoice_email_bcc_addresses)
  const orgNumber = providerText(mapped.org_number)
  const customerNumber = providerText(mapped.customer_number)

  if (existing.org_number === null && existing.customer_type !== 'individual' && orgNumber) {
    changes.org_number = orgNumber
  }
  if (existing.contact_person === null && contactPerson) changes.contact_person = contactPerson
  if (existing.invoice_email_cc_addresses === null && cc) changes.invoice_email_cc_addresses = cc
  if (existing.invoice_email_bcc_addresses === null && bcc) changes.invoice_email_bcc_addresses = bcc
  if (existing.customer_number === null && customerNumber) changes.customer_number = customerNumber

  return Object.keys(changes).length > 0 ? changes : null
}

const digits = (value: unknown) => (typeof value === 'string' ? value.replace(/\D/g, '') : '')

/**
 * The supplier twin of buildCustomerMetadataEnrichment, under the same rule.
 *
 * The bank account is one block, like the address: filled only on a card
 * with neither a clearing nor an account number, so a clearing number the
 * user typed is never paired with the provider's account. A card whose
 * free-text bank_account an earlier import wrote, the same account without
 * its clearing number, gets the block too; one the user wrote another
 * account into keeps it.
 */
export function buildSupplierEnrichment(
  existing: ExistingSupplierDetails,
  mapped: Record<string, unknown>,
): SupplierEnrichment | null {
  const changes: SupplierEnrichment = partyDetailsEnrichment(existing, mapped)
  for (const column of SUPPLIER_COLUMNS) {
    const value = providerText(mapped[column])
    if (existing[column] === null && value !== undefined) changes[column] = value
  }
  const clearing = providerText(mapped.clearing_number)
  const account = providerText(mapped.account_number)
  const legacy = digits(existing.bank_account)
  if (existing.clearing_number === null && existing.account_number === null && account !== undefined
    && (!legacy || legacy === digits(account) || legacy === digits(`${clearing ?? ''}${account}`))) {
    changes.account_number = account
    if (clearing !== undefined) changes.clearing_number = clearing
  }
  return Object.keys(changes).length > 0 ? changes : null
}

type EnrichmentWrite = { data: { id: string } | null; error: { message: string; code?: string } | null }

const fillsAddress = (changes: PartyDetailsEnrichment) => changes.address_line1 !== undefined
  || changes.address_line2 !== undefined || changes.postal_code !== undefined || changes.city !== undefined

/**
 * Write a customer enrichment. Every column it fills must still be NULL at
 * the write, or nothing is written: a value the user typed after the card was
 * read stays. `data` is null when the card changed in between.
 */
export async function writeCustomerEnrichment(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  changes: CustomerMetadataEnrichment,
): Promise<EnrichmentWrite> {
  let query = supabase
    .from('customers')
    // Object literal, not the record itself: absent keys serialize away, and
    // the phantom-column guard can resolve the columns.
    .update({
      contact_person: changes.contact_person,
      invoice_email_cc_addresses: changes.invoice_email_cc_addresses,
      invoice_email_bcc_addresses: changes.invoice_email_bcc_addresses,
      org_number: changes.org_number,
      customer_number: changes.customer_number,
      email: changes.email,
      phone: changes.phone,
      address_line1: changes.address_line1,
      address_line2: changes.address_line2,
      postal_code: changes.postal_code,
      city: changes.city,
      country: changes.country,
      vat_number: changes.vat_number,
      notes: changes.notes,
    })
    .eq('id', id)
    .eq('company_id', companyId)
  if (changes.contact_person !== undefined) query = query.is('contact_person', null)
  if (changes.invoice_email_cc_addresses !== undefined) query = query.is('invoice_email_cc_addresses', null)
  if (changes.invoice_email_bcc_addresses !== undefined) query = query.is('invoice_email_bcc_addresses', null)
  if (changes.org_number !== undefined) query = query.is('org_number', null)
  if (changes.customer_number !== undefined) query = query.is('customer_number', null)
  if (changes.email !== undefined) query = query.is('email', null)
  if (changes.phone !== undefined) query = query.is('phone', null)
  if (fillsAddress(changes)) {
    query = query.is('address_line1', null).is('address_line2', null).is('postal_code', null).is('city', null)
  }
  if (changes.country !== undefined) query = query.is('country', null)
  if (changes.vat_number !== undefined) query = query.is('vat_number', null)
  if (changes.notes !== undefined) query = query.is('notes', null)
  const { data, error } = await query.select('id').maybeSingle()
  return { data: (data as { id: string } | null) ?? null, error }
}

/** The supplier twin of writeCustomerEnrichment. */
export async function writeSupplierEnrichment(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  changes: SupplierEnrichment,
): Promise<EnrichmentWrite> {
  let query = supabase
    .from('suppliers')
    .update({
      org_number: changes.org_number,
      email: changes.email,
      phone: changes.phone,
      address_line1: changes.address_line1,
      address_line2: changes.address_line2,
      postal_code: changes.postal_code,
      city: changes.city,
      country: changes.country,
      vat_number: changes.vat_number,
      bankgiro: changes.bankgiro,
      plusgiro: changes.plusgiro,
      clearing_number: changes.clearing_number,
      account_number: changes.account_number,
      iban: changes.iban,
      bic: changes.bic,
      default_expense_account: changes.default_expense_account,
      notes: changes.notes,
    })
    .eq('id', id)
    .eq('company_id', companyId)
  if (changes.org_number !== undefined) query = query.is('org_number', null)
  if (changes.email !== undefined) query = query.is('email', null)
  if (changes.phone !== undefined) query = query.is('phone', null)
  if (fillsAddress(changes)) {
    query = query.is('address_line1', null).is('address_line2', null).is('postal_code', null).is('city', null)
  }
  if (changes.country !== undefined) query = query.is('country', null)
  if (changes.vat_number !== undefined) query = query.is('vat_number', null)
  if (changes.bankgiro !== undefined) query = query.is('bankgiro', null)
  if (changes.plusgiro !== undefined) query = query.is('plusgiro', null)
  if (changes.account_number !== undefined) query = query.is('clearing_number', null).is('account_number', null)
  if (changes.iban !== undefined) query = query.is('iban', null)
  if (changes.bic !== undefined) query = query.is('bic', null)
  if (changes.default_expense_account !== undefined) query = query.is('default_expense_account', null)
  if (changes.notes !== undefined) query = query.is('notes', null)
  const { data, error } = await query.select('id').maybeSingle()
  return { data: (data as { id: string } | null) ?? null, error }
}
