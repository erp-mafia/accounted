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
beforeEach(()=>{
  vi.clearAllMocks();verify.mockReturnValue(null)
  worker.mockResolvedValue({jobs:1,chunks:3})
  sweeps.mockResolvedValue({considered:1,swept:1})
  rpc.mockImplementation(async(fn:string)=>fn==='check_invoice_payment_row_invariant'
    ? {data:{missing_payment_rows:0,companies:0,sample_invoice_ids:[]},error:null}
    : {data:{duplicate_groups:0,missing_holds:0,stale_holds:0},error:null})
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
    rpc.mockImplementation(async(fn:string)=>fn==='check_invoice_payment_row_invariant'
      ? {data:{missing_payment_rows:0,companies:0,sample_invoice_ids:[]},error:null}
      : {data:{duplicate_groups:1,missing_holds:0,stale_holds:0},error:null})
    expect((await check(request())).status).toBe(503)
    expect(rpc).toHaveBeenCalledWith('check_sie_import_invariants')
  })
  it('surfaces a paid invoice whose payment voucher has no payment row (#2019)',async()=>{
    rpc.mockImplementation(async(fn:string)=>fn==='check_invoice_payment_row_invariant'
      ? {data:{missing_payment_rows:2,companies:1,sample_invoice_ids:['inv-1','inv-2']},error:null}
      : {data:{duplicate_groups:0,missing_holds:0,stale_holds:0},error:null})
    const response=await check(request())
    expect(response.status).toBe(503)
    expect(rpc).toHaveBeenCalledWith('check_invoice_payment_row_invariant')
    expect((await response.json()).paymentRows).toEqual({missing_payment_rows:2,companies:1,sample_invoice_ids:['inv-1','inv-2']})
  })
  it('fails the scan when the payment-row check cannot run',async()=>{
    rpc.mockImplementation(async(fn:string)=>fn==='check_invoice_payment_row_invariant'
      ? {data:null,error:{message:'statement timeout'}}
      : {data:{duplicate_groups:0,missing_holds:0,stale_holds:0},error:null})
    expect((await check(request())).status).toBe(500)
  })
  it('acknowledges a clean invariant scan',async()=>{
    const response=await check(request())
    expect(response.status).toBe(200)
    expect((await response.json()).paymentRows).toEqual({missing_payment_rows:0,companies:0,sample_invoice_ids:[]})
  })
})
