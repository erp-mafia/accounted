import {beforeEach,describe,expect,it,vi} from 'vitest'
import {NextResponse} from 'next/server'
const {verify,worker,rpc,sweeps}=vi.hoisted(()=>({verify:vi.fn(),worker:vi.fn(),rpc:vi.fn(),sweeps:vi.fn()}))
vi.mock('@/lib/auth/cron',()=>({verifyCronSecret:verify}))
vi.mock('@/lib/import/sie-job-worker',()=>({runSIEWorker:worker}))
vi.mock('@/lib/import/sie-post-import-sweep',()=>({runPendingSIEBankSweeps:sweeps}))
vi.mock('@/lib/auth/api-keys',()=>({createServiceClientNoCookies:()=>({rpc})}))
import {GET as run} from '../route'
import {GET as check} from '../../../invariants/cron/route'
const request=()=>new Request('https://example.test/api/import/sie/worker/cron')
type Answer={data:unknown,error:{message:string,code?:string}|null}
const timeout={message:'canceling statement due to statement timeout',code:'57014'}
const ok=(data:unknown):Answer=>({data,error:null})
const cleanJobs={missing_holds:0,stale_holds:0,paused_jobs:0,expired_leases:0,oldest_unresolved:null}
const cleanPage={companies_checked:2,last_company_id:'company-2',done:true,duplicate_groups:0,extra_vouchers:0,duplicate_samples:[]}
const cleanPaymentRows={missing_payment_rows:0,companies:0,sample_invoice_ids:[]}
/** Answers each invariant RPC; `pages` answers the duplicate-voucher pages in call order. */
function answer({jobs=ok(cleanJobs),paymentRows=ok(cleanPaymentRows),pages=[ok(cleanPage)]}:{jobs?:Answer,paymentRows?:Answer,pages?:Answer[]}={}) {
  let page=0
  rpc.mockImplementation(async(fn:string)=>{
    if (fn==='check_sie_import_job_invariants') return jobs
    if (fn==='check_invoice_payment_row_invariant') return paymentRows
    if (fn==='check_sie_import_duplicate_vouchers') return pages[Math.min(page++,pages.length-1)]
    throw new Error(`unexpected rpc ${fn}`)
  })
}
beforeEach(()=>{
  vi.clearAllMocks();verify.mockReturnValue(null)
  worker.mockResolvedValue({jobs:1,chunks:3})
  sweeps.mockResolvedValue({considered:1,swept:1})
  answer()
})
describe('SIE recovery and invariant schedules',()=>{
  it.each([run,check])('requires the cron secret',async(route)=>{
    verify.mockReturnValue(NextResponse.json({error:'Unauthorized'},{status:401}))
    expect((await route(request())).status).toBe(401)
    expect(worker).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(sweeps).not.toHaveBeenCalled()
  })
  it('runs two recovery claimers whose ownership is decided in the database',async()=>{
    const response=await run(request())
    expect(worker).toHaveBeenCalledTimes(2)
    expect((await response.json()).data).toEqual({jobs:2,chunks:6,bankSweeps:{considered:1,swept:1}})
  })
  it('recovers unfinished post-import bank sweeps alongside the workers (#2835)',async()=>{
    await run(request())
    expect(sweeps).toHaveBeenCalledTimes(1)
  })
  it('surfaces violated ledger invariants as a failed scheduled check',async()=>{
    answer({pages:[ok({...cleanPage,duplicate_groups:1,extra_vouchers:1,duplicate_samples:[{n:2}]})]})
    const response=await check(request())
    expect(response.status).toBe(503)
    expect(rpc).toHaveBeenCalledWith('check_sie_import_duplicate_vouchers',{p_after_company_id:null,p_company_limit:500})
    expect((await response.json()).data).toMatchObject({duplicate_groups:1,extra_vouchers:1,duplicate_samples:[{n:2}]})
  })
  it('reports copies of pre-batch imported vouchers without failing the run: none can be added any more',async()=>{
    answer({pages:[ok({...cleanPage,legacy_duplicate_groups:4861,legacy_extra_vouchers:4861})]})
    const response=await check(request())
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({duplicate_groups:0,legacy_duplicate_groups:4861,legacy_extra_vouchers:4861})
  })
  it('fails the run on a copy the import engine made, whatever the legacy copies',async()=>{
    answer({pages:[ok({...cleanPage,duplicate_groups:1,extra_vouchers:1,duplicate_samples:[{n:2}],legacy_duplicate_groups:4861,legacy_extra_vouchers:4861})]})
    expect((await check(request())).status).toBe(503)
  })
  it('surfaces a fiscal year held by a finished import job',async()=>{
    answer({jobs:ok({...cleanJobs,stale_holds:1})})
    const response=await check(request())
    expect(response.status).toBe(503)
    expect((await response.json()).data).toMatchObject({stale_holds:1,missing_holds:0,duplicate_groups:0})
  })
  it('surfaces a paid invoice whose payment voucher has no payment row (#2019)',async()=>{
    answer({paymentRows:ok({missing_payment_rows:2,companies:1,sample_invoice_ids:['inv-1','inv-2']})})
    const response=await check(request())
    expect(response.status).toBe(503)
    expect(rpc).toHaveBeenCalledWith('check_invoice_payment_row_invariant')
    expect((await response.json()).paymentRows).toEqual({missing_payment_rows:2,companies:1,sample_invoice_ids:['inv-1','inv-2']})
  })
  it('fails the scan when the payment-row check cannot run, and still reports the SIE checks',async()=>{
    answer({paymentRows:{data:null,error:timeout}})
    const response=await check(request())
    expect(response.status).toBe(500)
    const body=await response.json()
    expect(body.complete).toBe(false)
    expect(body.checks.invoice_payment_rows).toEqual({finished:false,code:'57014'})
    expect(body.checks.sie_import_jobs).toEqual({finished:true})
    expect(body.checks.sie_import_duplicates).toEqual({finished:true,companies_checked:2,last_company_id:'company-2'})
    expect(body.data).toMatchObject({duplicate_groups:0,missing_holds:0,stale_holds:0})
  })
  it('reports how far a duplicate scan got when a page times out, as an incomplete run',async()=>{
    answer({pages:[
      ok({...cleanPage,companies_checked:500,last_company_id:'company-500',done:false}),
      {data:null,error:timeout},
    ]})
    const response=await check(request())
    expect(response.status).toBe(500)
    expect(rpc).toHaveBeenLastCalledWith('check_sie_import_duplicate_vouchers',{p_after_company_id:'company-500',p_company_limit:500})
    const body=await response.json()
    expect(body.complete).toBe(false)
    expect(body.checks.sie_import_duplicates).toEqual({finished:false,companies_checked:500,last_company_id:'company-500',
      stopped:'page_failed',code:'57014'})
    expect(JSON.stringify(body)).not.toContain('canceling statement')
    expect(body.checks.sie_import_jobs).toEqual({finished:true})
    expect(body.paymentRows).toEqual(cleanPaymentRows)
  })
  it('reports a duplicate found before the scan stopped as a violation',async()=>{
    answer({pages:[
      ok({...cleanPage,companies_checked:500,last_company_id:'company-500',done:false,duplicate_groups:1,extra_vouchers:1}),
      {data:null,error:timeout},
    ]})
    const response=await check(request())
    expect(response.status).toBe(503)
    expect((await response.json()).complete).toBe(false)
  })
  it('runs the duplicate scan when the job check cannot run',async()=>{
    answer({jobs:{data:null,error:timeout}})
    const response=await check(request())
    expect(response.status).toBe(500)
    expect(rpc).toHaveBeenCalledWith('check_sie_import_duplicate_vouchers',{p_after_company_id:null,p_company_limit:500})
    const body=await response.json()
    expect(body.checks.sie_import_jobs).toEqual({finished:false,code:'57014'})
    expect(body.data).not.toHaveProperty('missing_holds')
    expect(body.data).toMatchObject({duplicate_groups:0})
  })
  it('acknowledges a clean invariant scan',async()=>{
    const response=await check(request())
    expect(response.status).toBe(200)
    const body=await response.json()
    expect(body.complete).toBe(true)
    expect(body.paymentRows).toEqual(cleanPaymentRows)
    expect(body.data).toEqual({duplicate_groups:0,extra_vouchers:0,duplicate_samples:[],legacy_duplicate_groups:0,legacy_extra_vouchers:0,...cleanJobs})
  })
})
