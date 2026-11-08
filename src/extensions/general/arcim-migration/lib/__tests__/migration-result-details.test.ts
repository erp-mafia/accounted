import {describe,it,expect} from 'vitest'
import {createQueuedMockSupabase} from '@/tests/helpers'
import {readMigrationSkipReasons,readPendingImportPayables} from '../migration-result-details'
describe('migration result details',()=>{
  it('keeps the historical exclusion distinct from unchanged and unknown receipt reasons',async()=>{
    const db=createQueuedMockSupabase();db.enqueue({data:[{resource:'salesInvoices',receipt:{reason:'historical_receivable'}},{resource:'supplierInvoices',receipt:{reason:'outsideFiscalYears'}},{resource:'customers',receipt:{reason:'unknown'}}]})
    expect(await readMigrationSkipReasons(db.supabase as never,'company','job')).toEqual({salesInvoices:{historicalReceivable:1},supplierInvoices:{outsideFiscalYears:1}})
    expect(db.findCalls('migration_job_chunks','eq')).toContainEqual(['company_id','company'])
  })
  it('shows future unpaid invoices only when their targets belong to this import',async()=>{
    const db=createQueuedMockSupabase();db.enqueueMany([{data:[{id:'telia',supplier_invoice_number:'20508368261',due_date:'2026-11-30',remaining_amount:1499,currency:'SEK'},
      {id:'unrelated',supplier_invoice_number:'other',due_date:'2026-12-01',remaining_amount:1,currency:'SEK'}]},{data:[{target_id:'telia'}]}])
    expect(await readPendingImportPayables(db.supabase as never,'company','job','2026-11-08')).toMatchObject({count:1,items:[{id:'telia',dueDate:'2026-11-30',remaining:1499}]})
    expect(db.findCalls('supplier_invoices','gte')).toContainEqual(['due_date','2026-11-08'])
    expect(db.findCalls('migration_job_chunks','eq')).toContainEqual(['job_id','job'])
    expect(db.findCalls('supplier_invoices','gt')).toContainEqual(['remaining_amount',0.005])
  })
  it('does not query mappings when all payables are settled, credited or already overdue',async()=>{
    const db=createQueuedMockSupabase();db.enqueue({data:[]})
    expect(await readPendingImportPayables(db.supabase as never,'company','job','2026-11-08')).toEqual({count:0,items:[]})
    expect(db.supabase.from).toHaveBeenCalledTimes(1)
  })
})
