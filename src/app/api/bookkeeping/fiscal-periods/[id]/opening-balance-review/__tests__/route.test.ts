import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const queued=createQueuedMockSupabase()
const {supabase}=queued
const auth=vi.fn(),write=vi.fn()
vi.mock('@/lib/auth/require-auth',()=>({requireAuth:(...args:unknown[])=>auth(...args)}))
vi.mock('@/lib/auth/require-write',()=>({requireWritePermission:(...args:unknown[])=>write(...args)}))
vi.mock('@/lib/company/context',()=>({getActiveCompanyId:vi.fn().mockResolvedValue('company-1'),requireCompanyId:vi.fn().mockResolvedValue('company-1')}))
import { POST } from '../route'

const id='11111111-1111-4111-8111-111111111111'
const token='22222222-2222-4222-8222-222222222222'
const params={params:Promise.resolve({id})}
const request=(body:unknown={reviewToken:token,expectedEntryId:id})=>new Request('https://example.test/review',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
})
// The year as lib/import/opening-balance/review.ts reads it before the RPC.
const openReview={id,name:'Räkenskapsår 2026',opening_balance_entry_id:id,opening_balance_review_token:token,
  opening_balance_review_reason:'import',opening_balance_review_import_id:'33333333-3333-4333-8333-333333333333'}
beforeEach(()=>{
  vi.clearAllMocks();queued.reset()
  auth.mockResolvedValue({user:{id:'actor-1'},supabase})
  write.mockResolvedValue({ok:true})
})
describe('opening balance manual review',()=>{
  it('requires authentication',async()=>{
    auth.mockResolvedValue({user:null,supabase,error:NextResponse.json({error:'Unauthorized'},{status:401})})
    expect((await POST(request(),params)).status).toBe(401)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('refuses viewers before invoking the RPC',async()=>{
    write.mockResolvedValue({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
    expect((await POST(request(),params)).status).toBe(403)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('rejects malformed or actor-forging input',async()=>{
    expect((await POST(request({reviewToken:'bad',expectedEntryId:id}),params)).status).toBe(400)
    expect((await POST(request({reviewToken:token,expectedEntryId:id,p_actor:'other'}),params)).status).toBe(400)
    expect((await POST(request(),{params:Promise.resolve({id:'bad'})})).status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('answers 404 for a year outside the company, before the RPC',async()=>{
    queued.enqueue({data:null})
    const response=await POST(request(),params)
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('OB_PERIOD_NOT_FOUND')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('answers 409 when the year has no open review, or another one than the dialog showed',async()=>{
    queued.enqueue({data:{...openReview,opening_balance_review_token:null}})
    const none=await POST(request(),params)
    expect(none.status).toBe(409)
    expect((await none.json()).error.code).toBe('OB_REVIEW_NOT_PENDING')
    queued.enqueue({data:{...openReview,opening_balance_review_token:'44444444-4444-4444-8444-444444444444'}})
    const moved=await POST(request(),params)
    expect(moved.status).toBe(409)
    expect((await moved.json()).error.code).toBe('OB_REVIEW_CHANGED')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['42501','',403,'FORBIDDEN'],
    ['P0002','',404,'OB_PERIOD_NOT_FOUND'],
    ['40001','',409,'OB_REVIEW_CHANGED'],
    ['55000','Opening balance review changed; reload before confirming',409,'OB_REVIEW_CHANGED'],
    ['55000','SIE import is unfinished: review after it completes',409,'OB_REVIEW_IMPORT_RUNNING'],
    ['55P03','',409,'OB_REVIEW_CHANGED'],
  ])('maps database refusal %s %s to %s %s',async(code,message,status,errorCode)=>{
    queued.enqueue({data:openReview})
    queued.enqueue({data:null,error:{code,message:message||'Database refusal'}})
    const response=await POST(request(),params)
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(errorCode)
  })
  it('answers 500 for a database failure that is not a refusal',async()=>{
    queued.enqueue({data:openReview})
    queued.enqueue({data:null,error:{code:'XX000',message:'Database failure'}})
    expect((await POST(request(),params)).status).toBe(500)
  })
  it('passes the authenticated actor and exact review snapshot',async()=>{
    queued.enqueue({data:openReview})
    queued.enqueue({data:null,error:null})
    const response=await POST(request(),params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({data:{reviewed:true}})
    expect(supabase.rpc).toHaveBeenCalledWith('acknowledge_sie_opening_balance_review',{
      p_company_id:'company-1',p_period_id:id,p_actor:'actor-1',p_review_token:token,p_expected_entry_id:id,
    })
    expect(queued.findCalls('fiscal_periods','eq')).toEqual(expect.arrayContaining([['id',id],['company_id','company-1']]))
  })
})
