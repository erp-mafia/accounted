import type { SupabaseClient } from '@supabase/supabase-js'

const EXTERNAL_LEDGER_REPORTS = new Set([
  'gnubok_get_trial_balance','gnubok_get_vat_report','gnubok_vat_review_widget','gnubok_vat_close_check',
  'gnubok_get_kpi_report','gnubok_get_income_statement','gnubok_get_balance_sheet','gnubok_get_general_ledger',
  'gnubok_get_ar_ledger','gnubok_get_supplier_ledger','gnubok_get_dimension_pnl','gnubok_get_salary_journal',
  'gnubok_query_journal','gnubok_get_reconciliation_status','gnubok_year_end_readiness',
  'gnubok_preview_arsredovisning','gnubok_validate_arsredovisning',
  'gnubok_vat_declaration_validate',
])

/** An external report has no persistent dashboard banner. Hold the complete
 * response, including PDF rendering, behind the same database read lease.
 * Status polling and reference-data reads remain available during recovery.
 */
export function withSIEExternalReport<T>(supabase:SupabaseClient,companyId:string|undefined,
  operation:string,read:()=>Promise<T>):Promise<T> {
  return companyId && (operation.startsWith('reports.') || EXTERNAL_LEDGER_REPORTS.has(operation))
    ? withSIEPeriodRead(supabase,companyId,'report_export',read) : read()
}

/** Keep a multi-request export/filing outside unfinished imports. */
export async function withSIEPeriodRead<T>(supabase: SupabaseClient, companyId: string,
  purpose: 'sie_export' | 'vat_submission' | 'report_export', read: () => Promise<T>,
): Promise<T> {
  const {data:token,error} = await supabase.rpc('acquire_sie_period_read',{p_company_id:companyId,p_purpose:purpose})
  if (error || !token) throw Object.assign(new Error(error?.message ?? 'Importkontrollen kunde inte genomföras.'), {
    code: error?.code === '55000' ? 'CONFLICT' : error?.code,
  })
  try {
    const result = await read()
    const finished = await supabase.rpc('finish_sie_period_read',{p_company_id:companyId,p_token:token,p_require_valid:true})
    if (finished.error) throw new Error(finished.error.message)
    return result
  } catch (error) {
    await supabase.rpc('finish_sie_period_read',{p_company_id:companyId,p_token:token,p_require_valid:false})
    throw error
  }
}
