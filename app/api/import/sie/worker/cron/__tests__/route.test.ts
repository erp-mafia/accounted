import {beforeEach,describe,expect,it,vi} from 'vitest'
import {NextResponse} from 'next/server'
const {verify,worker,rpc}=vi.hoisted(()=>({verify:vi.fn(),worker:vi.fn(),rpc:vi.fn()}))
vi.mock('@/lib/auth/cron',()=>({verifyCronSecret:verify}))
vi.mock('@/lib/import/sie-job-worker',()=>({runSIEWorker:worker}))
vi.mock('@/lib/auth/api-keys',()=>({createServiceClientNoCookies:()=>({rpc})}))
import {GET as run} from '../route'
import {GET as check} from '../../../invariants/cron/route'
const request=()=>new Request('https://example.test/api/import/sie/worker/cron')
beforeEach(()=>{
  vi.clearAllMocks();verify.mockReturnValue(null)
  worker.mockResolvedValue({jobs:1,chunks:3})
  rpc.mockResolvedValue({data:{duplicate_groups:0,missing_holds:0,stale_holds:0},error:null})
})
describe('SIE recovery and invariant schedules',()=>{
  it.each([run,check])('requires the cron secret',async(route)=>{
    verify.mockReturnValue(NextResponse.json({error:'Unauthorized'},{status:401}))
    expect((await route(request())).status).toBe(401)
    expect(worker).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled()
  })
  it('runs two recovery claimers whose ownership is decided in the database',async()=>{
    const response=await run(request())
    expect(worker).toHaveBeenCalledTimes(2)
    expect((await response.json()).data).toEqual({jobs:2,chunks:6})
  })
  it('surfaces violated ledger invariants as a failed scheduled check',async()=>{
    rpc.mockResolvedValue({data:{duplicate_groups:1,missing_holds:0,stale_holds:0},error:null})
    expect((await check(request())).status).toBe(503)
    expect(rpc).toHaveBeenCalledWith('check_sie_import_invariants')
  })
  it('acknowledges a clean invariant scan',async()=>{expect((await check(request())).status).toBe(200)})
})
