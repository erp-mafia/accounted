/**
 * The one door to record_invoice_write_off.
 *
 * The function is granted to the service role only (migration
 * 20261021120700_invoice_write_offs), so no signed-in person can record a
 * kundförlust decision by calling it directly, whatever CUSTOMER_LOSS_ENABLED
 * says. lib/customer-loss calls it here, through the service client, after
 * the route or operation has authenticated the person, and after the check
 * the function used to make for a signed-in caller: the acting person is a
 * member of the company and not a viewer. That person is recorded as
 * decided_by.
 *
 * Kept free of engine imports, like reversal.ts, so the engine can reach it
 * through the storno path without a cycle.
 */
import { createServiceClient } from '@/lib/supabase/server'

/** A numeric as the decision rows hold it (PostgREST answers numeric as a string or a number). */
type Numeric = number | string

/** The arguments of record_invoice_write_off apart from the company and the person. */
export interface WriteOffRecordArgs {
  p_id: string
  p_invoice_id: string
  p_kind: string
  p_entry_date: string
  p_amount: Numeric
  p_net_amount: Numeric
  p_vat_amount: Numeric
  p_vat_by_rate: unknown
  p_reserve_released: Numeric
  p_journal_entry_id: string | null
  p_evidence_document_id: string | null
  p_reason: string
  p_case_id: string | null
  p_reverses_id: string | null
}

export interface WriteOffRecordResult {
  data: unknown
  error: { message: string; code?: string } | null
}

/**
 * Whether the person may record kundförlust decisions in the company: a
 * member who is not a viewer (the function's own rule for a signed-in
 * caller). Throws when the membership cannot be read: unknown is never yes.
 */
export async function isCustomerLossWriter(companyId: string, userId: string): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .neq('role', 'viewer')
    .maybeSingle()
  if (error) throw new Error(`customer loss: membership lookup failed: ${error.message}`)
  return !!data
}

/**
 * record_invoice_write_off as the service role, for `actingUserId`. Refuses
 * (CUSTOMER_LOSS_FORBIDDEN, as the function did) a person who is not a
 * writer in the company.
 */
export async function recordInvoiceWriteOff(
  companyId: string,
  actingUserId: string,
  args: WriteOffRecordArgs,
): Promise<WriteOffRecordResult> {
  if (!(await isCustomerLossWriter(companyId, actingUserId))) {
    return { data: null, error: { message: 'CUSTOMER_LOSS_FORBIDDEN: not a writer in this company', code: '42501' } }
  }
  const { data, error } = await createServiceClient().rpc('record_invoice_write_off', {
    ...args,
    p_company_id: companyId,
    p_decided_by: actingUserId,
  })
  return { data, error: error ? { message: error.message, code: error.code } : null }
}
