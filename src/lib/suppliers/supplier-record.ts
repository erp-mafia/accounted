/**
 * The supplier record, defined once for every door that reads one supplier:
 * v1 GET /suppliers/{id} (and the PATCH and DELETE responses) and the MCP
 * drill-in gnubok_get_supplier.
 *
 * party-readers-cover-writers.test.ts pins the select to the schema's fields
 * and the record to every field a supplier writer accepts (crm#1061).
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tolerateMissingDefaultDimensions } from '@/lib/suppliers/default-dimensions'

export const SupplierRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier_type: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  /** Swedish bank account: clearing number and account number, as supplied. */
  clearing_number: z.string().nullable(),
  account_number: z.string().nullable(),
  default_expense_account: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  /** The self-billing agreement with the supplier (ML 2023:200 17 kap 15 §), printed on a självfaktura to it; null = none (crm#1367). */
  self_billing_agreement_ref: z.string().nullable(),
  /** The supplier debits its invoices itself (autogiro, account debit): they stay out of to-pay lists and payments (crm#1463). */
  auto_debit: z.boolean(),
  /** Dimension bag {sie_dim_no: code} its new supplier invoices take when they name none (accounted#144). */
  default_dimensions: z.record(z.string(), z.string()),
  notes: z.string().nullable(),
  /** The party (motpart) behind the supplier: one per counterpart, shared with the customer side and the ledger. */
  party_id: z.string().uuid().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type SupplierRecord = z.infer<typeof SupplierRecordSchema>

/**
 * Explicit projection, never SELECT *: user_id and company_id stay out. A
 * literal, not built from the schema's keys, so supabase-js still types the
 * rows; the test pins it to exactly the schema's fields, in order.
 */
export const SUPPLIER_RECORD_COLUMNS =
  'id, name, supplier_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, bankgiro, plusgiro, bank_account, iban, bic, clearing_number, account_number, default_expense_account, default_payment_terms, default_currency, self_billing_agreement_ref, auto_debit, default_dimensions, notes, party_id, archived_at, created_at, updated_at'

/**
 * One supplier of the company, or null when no supplier with that id exists
 * in it. The error is the database's, for the door to translate into its own
 * envelope.
 */
export async function readSupplierRecord(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
): Promise<{ data: SupplierRecord | null; error: unknown }> {
  const { data, error } = await tolerateMissingDefaultDimensions(SUPPLIER_RECORD_COLUMNS, (columns) =>
    supabase
      .from('suppliers')
      .select(columns)
      .eq('company_id', companyId)
      .eq('id', supplierId)
      .maybeSingle(),
  )
  if (error) return { data: null, error }
  return { data: (data as unknown as SupplierRecord | null) ?? null, error: null }
}
