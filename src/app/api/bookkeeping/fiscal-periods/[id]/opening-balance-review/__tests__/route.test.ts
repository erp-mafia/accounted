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
  it.each([['42501',403],['P0002',404],['40001',409],['55000',409],['55P03',409],['XX000',500]])('maps database refusal %s to %s',async(code,status)=>{
    queued.enqueue({data:null,error:{code,message:'Database refusal'}})
    expect((await POST(request(),params)).status).toBe(status)
  })
  it('passes the authenticated actor and exact review snapshot',async()=>{
    queued.enqueue({data:null,error:null})
    const response=await POST(request(),params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({data:{reviewed:true}})
    expect(supabase.rpc).toHaveBeenCalledWith('acknowledge_sie_opening_balance_review',{
      p_company_id:'company-1',p_period_id:id,p_actor:'actor-1',p_review_token:token,p_expected_entry_id:id,
    })
  })
})
