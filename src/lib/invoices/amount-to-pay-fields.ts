/**
 * "Att betala" as a field of the v1 invoice response (crm#1487).
 *
 * `total` is the exact amount the books carry; the invoice asks the customer
 * for that total after öresavrundning and any ROT/RUT deduction
 * (getAmountToPay, the figure the PDF, the email and every payment QR print).
 * An integration had only `total` and `ore_rounding` to work that out, and
 * had to guess the company setting when `ore_rounding` was null. These two
 * fields are the document's own figures:
 *
 *   amount_to_pay        what the invoice asks for (negative on a credit note)
 *   ore_rounding_amount  the öresavrundning row it prints (0 when none)
 *
 * An issued invoice carries its own rounding choice (frozen at issue by the
 * invoices_freeze_ore_rounding trigger), so its figures never follow a later
 * change of the company setting. A draft without a choice is computed with
 * today's company setting: what it would ask for if it were issued now.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import type { CompanySettings } from '@/types'

/** The columns the two fields are derived from. */
export interface AmountToPayRow {
  total: number
  currency: string
  ore_rounding?: boolean | null
  deduction_total?: number | null
  credited_invoice_id?: string | null
}

export interface InvoiceAmountToPayFields {
  amount_to_pay: number
  ore_rounding_amount: number
}

/** The two fields for one row; `company` decides only a row without its own choice. */
export function invoiceAmountToPayFields(
  row: AmountToPayRow,
  company: Pick<CompanySettings, 'ore_rounding'> | null | undefined,
): InvoiceAmountToPayFields {
  const { rounding, toPay } = getAmountToPay(row, company)
  return { amount_to_pay: toPay, ore_rounding_amount: rounding.roundingDelta }
}

/**
 * The company setting the figures of `rows` need: read only when a row has no
 * choice of its own (a draft), else null. A failed read throws, so no figure
 * is ever computed on a guessed setting.
 */
export async function companyOreRoundingFor(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<{ ore_rounding?: boolean | null }>,
): Promise<Pick<CompanySettings, 'ore_rounding'> | null> {
  if (!rows.some((row) => row.ore_rounding == null)) return null
  const { data, error } = await supabase
    .from('company_settings')
    .select('ore_rounding')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company_settings.ore_rounding read failed: ${error.message}`)
  return data as Pick<CompanySettings, 'ore_rounding'> | null
}

/**
 * `rows` with the two fields added: the one projection every reader outside
 * the app gets them from (the v1 invoice and customer responses, the MCP
 * invoice reads), so no surface reports the exact total as what is owed.
 */
export async function withAmountToPay<T extends AmountToPayRow>(
  supabase: SupabaseClient,
  companyId: string,
  rows: T[],
): Promise<Array<T & InvoiceAmountToPayFields>> {
  const company = await companyOreRoundingFor(supabase, companyId, rows)
  return rows.map((row) => ({ ...row, ...invoiceAmountToPayFields(row, company) }))
}
