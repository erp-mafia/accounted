/**
 * Customer register (kundregister) create and update: the one write path behind
 * the dashboard's POST /api/customers and PATCH /api/customers/:id, the v1
 * POST, PATCH and bulk-create, and the approval of an agent's staged
 * gnubok_create_customer / gnubok_update_customer.
 *
 * The doors used to carry their own insert and their own rules, and they
 * drifted: the dashboard echoed a duplicate org number (for a sole trader, the
 * owner's personnummer) back in its 409, v1 bulk-create dropped customer_number
 * and language, the approval's insert wrote only the agent tool's own fields
 * and answered a duplicate org number with a raw database error, and the
 * approval's update skipped the foreign-business personnummer rule. CreateCustomerSchema and
 * UpdateCustomerSchema (lib/api/schemas.ts) are the one rule set, and the
 * writes live here.
 */
import type { z } from 'zod'
import type { CreateCustomerSchema, UpdateCustomerSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import { syncDraftVatHeadersForCustomer } from '@/lib/invoices/sync-draft-vat-headers'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { validateVatNumber, vatValidationColumns } from '@/lib/vat/vies-client'
import { COUNTRY_CONSISTENCY_MESSAGES, checkCountryConsistency } from '@/lib/vat/country-codes'
import type { Customer } from '@/types'
import { resolveDefaultPaymentTerms } from './default-payment-terms'
import { isMaskedPersonalNumber, maskCustomerPersonalNumber } from './mask-personal-number'
import {
  isOrgNumberRefusedOnIndividual,
  isPersonalNumberOrgNumberDisallowed,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
  personalNumberDigits,
} from '@/lib/invariants/personal-number-shape'
import {
  encryptCustomerPersonalNumber,
  maskCustomerRow,
  maskStoredCustomerPersonalNumber,
  revealStoredCustomerPersonalNumber,
} from './protect-personal-number'

export type CustomerCreateInput = z.output<typeof CreateCustomerSchema>
/** archived_at: only null, which un-archives (the v1 PATCH contract). */
export type CustomerUpdateInput = z.output<typeof UpdateCustomerSchema> & { archived_at?: null }

/**
 * The stored ciphertext shape of customers.personal_number
 * (customers_personal_number_check, 20260726110000). A staged operation
 * carries the personnummer only in this form: staging-pii-guard keeps the
 * plaintext out of pending_operations.
 */
export const PERSONAL_NUMBER_CIPHERTEXT_RE = /^[0-9a-f]{76,255}$/

export interface CustomerWriteOptions {
  dryRun?: boolean
  /**
   * The personnummer as ciphertext, for a caller that holds no plaintext: the
   * approval of an agent's staged create or update. On create it wins over
   * input.personal_number. On update, undefined leaves the personnummer out of
   * the change, null clears it.
   */
  personalNumberCiphertext?: string | null
}

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

function refuse(code: string, field: string): Refusal {
  return { ok: false, code, details: { field } }
}

/** A duplicate org number. Never echoes the value: for a sole trader it is the personnummer. */
const DUPLICATE_ORG_NUMBER: Refusal = refuse('CUSTOMER_DUPLICATE_ORG_NUMBER', 'org_number')

function countryMismatch(issue: keyof typeof COUNTRY_CONSISTENCY_MESSAGES): Refusal {
  const messages = COUNTRY_CONSISTENCY_MESSAGES[issue]
  return {
    ok: false,
    code: 'CUSTOMER_COUNTRY_MISMATCH',
    messageSv: messages.sv,
    details: { field: 'country', issue, message_sv: messages.sv, message_en: messages.en },
  }
}

/** The plaintext behind a ciphertext, or null when it cannot be read. */
function readCiphertext(ciphertext: string): string | null {
  try {
    return revealStoredCustomerPersonalNumber(ciphertext)
  } catch {
    return null
  }
}

/**
 * The VIES columns for an EU business's VAT number, resolved before the write
 * so the stored row never shows a stale verdict. Best effort: a VIES error
 * leaves the number unverified, never fails the save.
 */
async function viesColumns(
  ctx: OperationContext,
  vatNumber: string,
  previousVatNumber: string | null,
): Promise<{ vat_number_validated: boolean; vat_number_validated_at: string | null } | null> {
  try {
    return vatValidationColumns(await validateVatNumber(vatNumber), previousVatNumber, vatNumber)
  } catch (err) {
    ctx.log.warn('auto-VIES validation failed on customer save', err as Error)
    return { vat_number_validated: false, vat_number_validated_at: null }
  }
}

/**
 * Create one customer. The dry run answers the would-be record (no id, no
 * timestamps, VAT unverified: VIES runs only on the real insert).
 */
export async function createCustomer(
  ctx: OperationContext,
  input: CustomerCreateInput,
  options: CustomerWriteOptions = {},
): Promise<OperationOutcome<Customer>> {
  const { supabase, companyId, userId, log } = ctx

  const ciphertext = options.personalNumberCiphertext || null
  const plaintext = ciphertext ? null : input.personal_number || null
  // The schema refuses a plaintext personnummer on a business; a staged
  // ciphertext gets the same rule here.
  if ((ciphertext || plaintext) && input.customer_type !== 'individual') {
    return refuse('CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED', 'personal_number')
  }

  // Unset payment terms follow the company's own default, not a hardcoded 30.
  const defaultPaymentTerms = await resolveDefaultPaymentTerms(supabase, companyId, input.default_payment_terms)

  const row = {
    name: input.name,
    customer_type: input.customer_type,
    // Empty string clears the customer number, same as an explicit null.
    customer_number: input.customer_number || null,
    contact_person: input.contact_person ?? null,
    email: input.email || null,
    phone: input.phone ?? null,
    invoice_email_cc_addresses: input.invoice_email_cc_addresses ?? null,
    invoice_email_bcc_addresses: input.invoice_email_bcc_addresses ?? null,
    address_line1: input.address_line1 ?? null,
    address_line2: input.address_line2 ?? null,
    postal_code: input.postal_code ?? null,
    city: input.city ?? null,
    // Blank is none, as on the update below.
    address_state: input.address_state || null,
    // Always a code here: the schema resolves an omitted country.
    country: input.country,
    org_number: input.org_number || null,
    vat_number: input.vat_number || null,
    language: input.language ?? 'sv',
    default_payment_terms: defaultPaymentTerms,
    // Blank is none (lib/customers/invoice-reference.ts reads it so too).
    invoice_reference: input.invoice_reference || null,
    invoice_marking: input.invoice_marking || null,
    // Null follows the company's send order (lib/invoices/send-order.ts).
    invoice_send_way: input.invoice_send_way ?? null,
    notes: input.notes ?? null,
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        id: null,
        ...row,
        vat_number_validated: false,
        personal_number: plaintext
          ? maskCustomerPersonalNumber(plaintext)
          : maskStoredCustomerPersonalNumber(ciphertext),
        archived_at: null,
        created_at: null,
        updated_at: null,
      },
    }
  }

  const vies =
    row.customer_type === 'eu_business' && row.vat_number ? await viesColumns(ctx, row.vat_number, null) : null

  const { data, error } = await supabase
    .from('customers')
    .insert({
      ...row,
      user_id: userId,
      company_id: companyId,
      vat_number_validated: vies?.vat_number_validated ?? false,
      vat_number_validated_at: vies?.vat_number_validated_at ?? null,
      // Stored as ciphertext; customers_personal_number_check accepts that
      // shape only (20260726110000).
      personal_number: ciphertext ?? encryptCustomerPersonalNumber(plaintext),
    })
    .select()
    .single()
  if (error || !data) {
    if ((error as { code?: string } | null)?.code === '23505') return DUPLICATE_ORG_NUMBER
    log.error('customer insert failed', error)
    return { ok: false, code: 'CUSTOMER_CREATE_FAILED', error }
  }

  // The selected row carries the ciphertext; nothing past this point sees it.
  const customer = maskCustomerRow(data) as Customer
  await eventBus.emit({ type: 'customer.created', payload: { customer, companyId, userId } })
  return { ok: true, data: customer, created: true }
}

/** Fields an update copies onto the row as sent. */
const UPDATE_FIELDS = [
  'name', 'customer_type', 'contact_person', 'email', 'phone', 'invoice_email_cc_addresses',
  'invoice_email_bcc_addresses', 'address_line1', 'address_line2', 'postal_code', 'city', 'country',
  'org_number', 'vat_number', 'language', 'default_payment_terms', 'invoice_send_way', 'notes', 'archived_at',
] as const

/**
 * Update one customer with the fields sent. Every rule is judged on the row
 * as it will END UP, but only when the fields it reads are part of the change:
 * a legacy row that already breaks one must still be able to change its email.
 * The dry run answers the would-be record and `changes` (each changed field,
 * from and to), after the same checks.
 */
export async function updateCustomer(
  ctx: OperationContext,
  customerId: string,
  input: CustomerUpdateInput,
  options: CustomerWriteOptions = {},
): Promise<OperationOutcome<Customer>> {
  const { supabase, companyId, log } = ctx

  const emptyChange: Refusal = {
    ok: false,
    code: 'VALIDATION_ERROR',
    messageSv: 'Ange minst ett fält att ändra.',
    details: { field: 'body', message: 'At least one field must be supplied for update.' },
  }
  // A masked personnummer is "not supplied" (see below), so it alone is no change.
  const supplied = Object.entries(input).filter(
    ([key, value]) => value !== undefined && !(key === 'personal_number' && isMaskedPersonalNumber(value)),
  )
  if (options.personalNumberCiphertext === undefined && supplied.length === 0) return emptyChange

  const { data: existing, error: existingError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (existingError && (existingError as { code?: string }).code !== 'PGRST116') {
    log.error('customer lookup before update failed', existingError)
    return { ok: false, code: 'CUSTOMER_UPDATE_FAILED', error: existingError }
  }
  if (!existing) return { ok: false, code: 'CUSTOMER_NOT_FOUND' }

  // What the change does to the personnummer. No read returns the stored
  // value, only '********-1234' (or '********-????' when it could not be
  // decrypted), so a client echoing back what it read submits a mask: that is
  // "not supplied", never validated, stored or treated as a clear.
  const ciphertext = options.personalNumberCiphertext
  const plaintextSubmitted =
    ciphertext === undefined && input.personal_number !== undefined && !isMaskedPersonalNumber(input.personal_number)
  const personalNumberSubmitted = ciphertext !== undefined || plaintextSubmitted
  const submittedPlaintext = ciphertext ? readCiphertext(ciphertext) : plaintextSubmitted ? input.personal_number ?? null : null
  const personalNumberValue = Boolean(ciphertext) || Boolean(plaintextSubmitted && input.personal_number)

  const effectiveType = input.customer_type ?? existing.customer_type
  if (personalNumberValue && effectiveType !== 'individual') {
    return refuse('CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED', 'personal_number')
  }

  // A Swedish enskild firma's org number IS its owner's personnummer, so
  // swedish_business accepts one and the lists mask it; only the foreign
  // business types, which cannot have one, refuse it. '' is a clear and stays
  // a clear: only `undefined` falls back to the stored value.
  const effectiveOrgNumber = input.org_number ?? existing.org_number
  if (isPersonalNumberOrgNumberDisallowed(effectiveType, effectiveOrgNumber)) {
    return refuse('CUSTOMER_ORG_NUMBER_IS_PERSONAL', 'org_number')
  }

  // An individual has no org number.
  const individualOrgNumber =
    input.org_number !== undefined || input.customer_type !== undefined ? effectiveOrgNumber : undefined
  if (isOrgNumberRefusedOnIndividual(effectiveType, individualOrgNumber)) {
    return refuse('CUSTOMER_ORG_NUMBER_ON_INDIVIDUAL', 'org_number')
  }

  // The mirror image: a personnummer as an individual's org_number is the
  // personnummer in the wrong field. It is stored encrypted in
  // personal_number and org_number is cleared; a type change to individual
  // moves a stored one the same way. Next to a DIFFERENT personnummer in the
  // same change the two conflict.
  const rerouted = orgNumberHoldsPersonalNumber(effectiveType, individualOrgNumber)
    ? normalizeReroutedPersonalNumber(individualOrgNumber!)
    : null
  if (
    rerouted
    && personalNumberValue
    && submittedPlaintext
    && personalNumberDigits(submittedPlaintext) !== personalNumberDigits(rerouted)
  ) {
    return refuse('CUSTOMER_PERSONAL_NUMBER_CONFLICT', 'org_number')
  }

  // Country vs type vs VAT prefix (#2025).
  if (input.customer_type !== undefined || input.country !== undefined || input.vat_number !== undefined) {
    const issue = checkCountryConsistency({
      partyType: effectiveType,
      country: input.country ?? existing.country,
      vatNumber: input.vat_number ?? existing.vat_number,
    })
    if (issue) return countryMismatch(issue)
  }

  const updateData: Record<string, unknown> = {}
  for (const key of UPDATE_FIELDS) {
    if (input[key] !== undefined) updateData[key] = input[key]
  }
  // Empty string clears the customer number, same as an explicit null.
  if (input.customer_number !== undefined) updateData.customer_number = input.customer_number || null
  if (input.invoice_reference !== undefined) updateData.invoice_reference = input.invoice_reference || null
  if (input.invoice_marking !== undefined) updateData.invoice_marking = input.invoice_marking || null
  if (input.address_state !== undefined) updateData.address_state = input.address_state || null
  if (rerouted) updateData.org_number = null
  if (rerouted && !personalNumberValue) {
    updateData.personal_number = encryptCustomerPersonalNumber(rerouted)
  } else if (personalNumberSubmitted) {
    updateData.personal_number = ciphertext !== undefined ? ciphertext : encryptCustomerPersonalNumber(input.personal_number)
  } else if (input.customer_type !== undefined && effectiveType !== 'individual') {
    updateData.personal_number = null
  }

  if (Object.keys(updateData).length === 0) return emptyChange

  if (options.dryRun) {
    const current = maskCustomerRow(existing)
    const proposed = maskCustomerRow({ ...existing, ...updateData })
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of Object.keys(updateData)) {
      const from = (current as Record<string, unknown>)[key] ?? null
      const to = (proposed as Record<string, unknown>)[key] ?? null
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to }
    }
    return { ok: true, dryRun: true, preview: { ...proposed, changes } }
  }

  // VIES on an EU business's changed VAT number, resolved before the write.
  if (input.vat_number !== undefined && effectiveType === 'eu_business') {
    const columns = input.vat_number
      ? await viesColumns(ctx, input.vat_number, existing.vat_number)
      : { vat_number_validated: false, vat_number_validated_at: null }
    if (columns) Object.assign(updateData, columns)
  }

  const { data, error } = await supabase
    .from('customers')
    .update(updateData)
    .eq('id', customerId)
    .eq('company_id', companyId)
    .select()
    .maybeSingle()
  if (error) {
    const code = (error as { code?: string }).code
    if (code === 'PGRST116') return { ok: false, code: 'CUSTOMER_NOT_FOUND' }
    if (code === '23505') return DUPLICATE_ORG_NUMBER
    log.error('customer update failed', error)
    return { ok: false, code: 'CUSTOMER_UPDATE_FAILED', error }
  }
  if (!data) return { ok: false, code: 'CUSTOMER_NOT_FOUND' }

  // Type, country, VAT number or its validation may have changed: open drafts
  // to this customer re-derive their VAT header from it.
  await syncDraftVatHeadersForCustomer(supabase, companyId, customerId)

  return { ok: true, data: maskCustomerRow(data) as Customer }
}
