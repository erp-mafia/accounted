import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { UNSETTLED_SUPPLIER_INVOICE_STATUSES } from '@/lib/supplier-invoices/lifecycle'
import type { MigrationResource, MigrationResourceCounts, PendingImportPayables } from '@/lib/providers/migration-contract'

const reasonKeys = {historical_receivable:'historicalReceivable',outsideFiscalYears:'outsideFiscalYears',
  inactive:'inactive',zeroTotal:'zeroTotal',creditNoteInOldShape:'creditNoteInOldShape'} as const

/** Read recorded reasons rather than guessing why a counter is nonzero. */
export async function readMigrationSkipReasons(db:SupabaseClient,companyId:string,jobId:string) {
  const rows=await fetchAllRows<{resource:MigrationResource;receipt:{reason?:string}}>(({from,to})=>db
    .from('migration_job_chunks').select('resource,receipt').eq('company_id',companyId).eq('job_id',jobId)
    .eq('state','skipped').neq('receipt->>reason','unchanged').order('id').range(from,to))
  const result:Partial<Record<MigrationResource,MigrationResourceCounts['skipReasons']>>={}
  for(const row of rows){
    const key=reasonKeys[row.receipt.reason as keyof typeof reasonKeys]
    if(!key)continue
    const counts=result[row.resource]??={}
    counts[key]=(counts[key]??0)+1
  }
  return result
}

/** These invoices ARE imported; only payment matching awaits the due date. */
export async function readPendingImportPayables(db:SupabaseClient,companyId:string,jobId:string,
  today=todayIsoStockholm(),
):Promise<PendingImportPayables>{
  const invoices=await fetchAllRows<{id:string;supplier_invoice_number:string;due_date:string;remaining_amount:number;currency:string}>(({from,to})=>db
    .from('supplier_invoices').select('id,supplier_invoice_number,due_date,remaining_amount,currency')
    .eq('company_id',companyId).in('status',[...UNSETTLED_SUPPLIER_INVOICE_STATUSES,'partially_paid'])
    .gt('remaining_amount',0.005).gte('due_date',today).or('is_credit_note.is.null,is_credit_note.eq.false')
    .order('due_date').order('id').range(from,to))
  const imported=new Set<string>()
  for(let offset=0;offset<invoices.length;offset+=100){
    const rows=await fetchAllRows<{target_id:string}>(({from,to})=>db.from('migration_job_chunks').select('target_id')
      .eq('company_id',companyId).eq('job_id',jobId).eq('resource','supplierInvoices')
      .in('target_id',invoices.slice(offset,offset+100).map(row=>row.id)).order('id').range(from,to))
    for(const row of rows)imported.add(row.target_id)
  }
  const pending=invoices.filter(invoice=>imported.has(invoice.id))
  return {count:pending.length,items:pending.slice(0,20).map(row=>({id:row.id,invoiceNumber:row.supplier_invoice_number,
    dueDate:row.due_date,remaining:row.remaining_amount,currency:row.currency}))}
}
