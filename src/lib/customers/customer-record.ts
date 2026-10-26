/**
 * The customer record, defined once for every door that reads one customer:
 * v1 GET /customers/{id} (and the PATCH and DELETE responses) and the MCP
 * drill-in gnubok_get_customer.
 *
 * Before this, each door kept its own column list and the MCP side had none
 * for one customer at all: notes an agent wrote with gnubok_update_customer
 * could not be read back over MCP (crm#1061).
 * party-readers-cover-writers.test.ts pins the select to the schema's fields
 * and the record to every field a customer writer accepts.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { maskCustomerRow } from '@/lib/customers/protect-personal-number'
import type { OperationOutcome } from '@/lib/operations/types'

export const CustomerRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customer_type: z.string(),
  customer_number: z.string().nullable(),
  contact_person: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  invoice_email_cc_addresses: z.array(z.string()).nullable(),
  invoice_email_bcc_addresses: z.array(z.string()).nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  vat_number_validated: z.boolean(),
  // Always the masked display form ('********-1234'), never the stored value.
  personal_number: z.string().nullable(),
  /** Language of the customer's invoice PDF and email. */
  language: z.enum(['sv', 'en']),
  default_payment_terms: z.number(),
  /** Fakturareferens: the Er referens a new invoice to this customer gets when the request states none. */
  invoice_reference: z.string().nullable(),
  /** Märkning: the invoice_marking a new invoice to this customer gets when the request states none. */
  invoice_marking: z.string().nullable(),
  notes: z.string().nullable(),
  /** The party (motpart) behind the customer: one per counterpart, shared with the supplier side and the ledger. Null for private individuals. */
  party_id: z.string().uuid().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type CustomerRecord = z.infer<typeof CustomerRecordSchema>

/**
 * Explicit projection, never SELECT *: user_id and company_id (internal
 * scoping) and vat_number_validated_at (internal timestamp) stay out. A
 * literal, not built from the schema's keys, so supabase-js still types the
 * rows; the test pins it to exactly the schema's fields, in order.
 */
export const CUSTOMER_RECORD_COLUMNS =
  'id, name, customer_type, customer_number, contact_person, email, phone, invoice_email_cc_addresses, invoice_email_bcc_addresses, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, personal_number, language, default_payment_terms, invoice_reference, invoice_marking, notes, party_id, archived_at, created_at, updated_at'

/**
 * One customer of the company, personnummer masked, or null when no customer
 * with that id exists in it. The error is the database's, for the door to
 * translate into its own envelope.
 */
export async function readCustomerRecord(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<{ data: CustomerRecord | null; error: unknown }> {
  const { data, error } = await supabase
    .from('customers')
    .select(CUSTOMER_RECORD_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()
  if (error) return { data: null, error }
  if (!data) return { data: null, error: null }
  // The stored personal_number is ciphertext; it never leaves unmasked.
  return { data: maskCustomerRow(data as unknown as CustomerRecord), error: null }
}

const CUSTOMER_RECORD_KEYS = CUSTOMER_RECORD_COLUMNS.split(', ')

/**
 * A row the customer commands answered (lib/customers/customer-commands.ts),
 * already masked, cut to the record's fields: what every v1 customer write
 * returns. A field the row lacks (a dry run has no id or timestamps) is null.
 */
export function toCustomerRecord(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CUSTOMER_RECORD_KEYS.map((key) => [key, row[key] ?? null]))
}

/** A customer command's outcome with its row (or dry-run preview) cut to the record. */
export function customerRecordOutcome<T>(outcome: OperationOutcome<T>): OperationOutcome<Record<string, unknown>> {
  if (!outcome.ok) return outcome
  if (outcome.dryRun) {
    const { changes, ...row } = outcome.preview
    return { ...outcome, preview: { ...toCustomerRecord(row), ...(changes === undefined ? {} : { changes }) } }
  }
  return { ...outcome, data: toCustomerRecord(outcome.data as Record<string, unknown>) }
}
