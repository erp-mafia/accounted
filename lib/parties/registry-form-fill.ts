/**
 * Parties: filling a customer or supplier form from the register.
 *
 * The registry lookup was built for rows that already exist (the detail
 * page's "Hämta uppgifter" records facts on the row's party), so on the
 * create form people typed what SCB already knew. This is the form side:
 * which numbers may be looked up at all, and which fields a found company
 * fills. Pure: form values in, patch out. The hook in
 * components/parties/use-registry-autofill.ts decides when to call.
 */
import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { isLegalPersonOrgNumber } from './scb/org-number'
import { contactFill, fromRegistry, type RegistrySummary } from './registry-summary'

export interface RegistryLookupFound {
  found: true
  /** Canonical ten digits. */
  orgNumber: string
  /** The register's legal name in display case ("Webhallen Sverige AB"). */
  name: string
  registry: RegistrySummary
}

export interface RegistryLookupMissing {
  found: false
  orgNumber: string
}

export type RegistryLookup = RegistryLookupFound | RegistryLookupMissing

/**
 * The canonical ten digits when the typed value is a complete org number
 * of a Swedish legal person with a valid check digit; null for anything
 * else. A personnummer (a private person's, or a sole trader's org number)
 * is never a key: it must not reach the register, and the server refuses
 * it too (SCB_NOT_A_LEGAL_PERSON). Both checks are kept although a legal
 * person's number can never have personnummer shape: they guard different
 * things and each is cheap.
 */
export function registryLookupKey(orgNumber: string | null | undefined): string | null {
  const canonical = normalizeOrgNumber(orgNumber)
  if (!canonical) return null
  if (!isLegalPersonOrgNumber(canonical) || looksLikeSwedishPersonalNumber(canonical)) return null
  return canonical
}

export interface RegistryFormFields {
  name: string
  email: string
  phone: string
  address_line1: string
  address_line2: string
  postal_code: string
  city: string
  vat_number: string
}

export type RegistryFormField = keyof RegistryFormFields

export const REGISTRY_FORM_FIELDS: readonly RegistryFormField[] = ['name', 'email', 'phone', 'address_line1', 'address_line2', 'postal_code', 'city', 'vat_number']

/**
 * Which fields to set after a lookup. A field is filled when it is empty,
 * or when it still holds what the previous lookup put there (a corrected
 * number replaces its own fill); a value the person typed is never
 * replaced. Contact fields follow the row rule from registry-summary
 * (`contactFill`): the address is one unit, c/o on line 1 and street on
 * line 2. `fields` is what the form shows; nothing lands in a field the
 * person cannot see.
 */
export function registryFormFill(
  current: RegistryFormFields,
  now: RegistryLookupFound,
  before: RegistryLookupFound | null,
  fields: readonly RegistryFormField[] = REGISTRY_FORM_FIELDS,
): Partial<RegistryFormFields> {
  const out: Partial<RegistryFormFields> = {}
  const untouched = (value: string, previous: string | null | undefined) => value.trim() === '' || fromRegistry(value, previous)

  if (now.name && untouched(current.name, before?.name) && !fromRegistry(current.name, now.name)) out.name = now.name

  const vat = now.registry.vat_number
  if (vat && untouched(current.vat_number, before?.registry.vat_number) && !fromRegistry(current.vat_number, vat)) out.vat_number = vat

  const contact = contactFill(
    {
      email: current.email,
      phone: current.phone,
      address_line1: current.address_line1,
      address_line2: current.address_line2,
      postal_code: current.postal_code,
      city: current.city,
    },
    now.registry.contact,
    before?.registry.contact ?? null,
  )
  for (const [key, value] of Object.entries(contact)) out[key as Exclude<RegistryFormField, 'name' | 'vat_number'>] = value ?? ''

  const shown = new Set(fields)
  for (const key of Object.keys(out) as RegistryFormField[]) if (!shown.has(key)) delete out[key]
  return out
}

/**
 * The filled fields as the note under the org number lists them: the four
 * address columns collapse into one "adress", in a fixed order.
 */
export function describeFilledFields(filled: readonly string[]): Array<'name' | 'address' | 'email' | 'phone' | 'vat_number'> {
  const set = new Set(filled)
  const out: Array<'name' | 'address' | 'email' | 'phone' | 'vat_number'> = []
  if (set.has('name')) out.push('name')
  if (set.has('address_line1') || set.has('address_line2') || set.has('postal_code') || set.has('city')) out.push('address')
  if (set.has('email')) out.push('email')
  if (set.has('phone')) out.push('phone')
  if (set.has('vat_number')) out.push('vat_number')
  return out
}
