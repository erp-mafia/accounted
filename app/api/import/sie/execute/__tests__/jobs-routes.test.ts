import { beforeEach,describe,expect,it,vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const auth = vi.hoisted(()=>vi.fn())
const write = vi.hoisted(()=>vi.fn())
const submit = vi.hoisted(()=>vi.fn())
const action = vi.hoisted(()=>vi.fn())
vi.mock('@/lib/auth/require-auth',()=>({requireAuth:auth}))
vi.mock('@/lib/auth/require-write',()=>({requireWritePermission:write}))
vi.mock('@/lib/company/context',()=>({getActiveCompanyId:vi.fn().mockResolvedValue('company-1')}))
vi.mock('@/lib/import/sie-jobs',async load=>({...await load<typeof import('@/lib/import/sie-jobs')>(),submitSIEJob:submit,requestSIEJobAction:action}))
vi.mock('@/lib/import/sie-job-worker',()=>({runSIEWorker:vi.fn()}))
vi.mock('next/server',async load=>({...await load<typeof import('next/server')>(),after:vi.fn()}))

import {POST as execute} from '../route'
import {POST as upload} from '../../upload/route'
import {POST as act} from '../../[id]/action/route'
import {GET as holds} from '../../holds/route'

const queued=createQueuedMockSupabase()
const sign=vi.fn()
const supabase={...queued.supabase,storage:{from:vi.fn().mockReturnValue({createSignedUploadUrl:sign})}}
const params={params:Promise.resolve({id:'11111111-1111-4111-8111-111111111111'})}
const staticParams={params:Promise.resolve({})}
const routes={execute:(r:Request)=>execute(r,staticParams),upload:(r:Request)=>upload(r,staticParams),
  act:(r:Request)=>act(r,params),holds:(r:Request)=>holds(r,staticParams)}
const request=(body:unknown)=>new Request('https://example.test/api/import/sie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
const job={id:'11111111-1111-4111-8111-111111111111',job_state:'queued',chunks_done:0,chunks_total:0}
beforeEach(()=>{
  vi.clearAllMocks();queued.reset()
  auth.mockResolvedValue({user:{id:'actor-1'},supabase})
  write.mockResolvedValue({ok:true})
  sign.mockResolvedValue({data:{token:'upload-token'},error:null})
  submit.mockResolvedValue(job);action.mockResolvedValue(job)
})

describe('durable SIE HTTP boundaries',()=>{
  for(const [name,route] of Object.entries(routes)) it(`${name} requires authentication`,async()=>{
    auth.mockResolvedValue({user:null,supabase,error:NextResponse.json({error:'Unauthorized'},{status:401})})
    expect((await route(request({}))).status).toBe(401)
  })
  for(const [name,route] of Object.entries(routes).filter(([name])=>name!=='holds')) it(`${name} refuses viewers`,async()=>{
    write.mockResolvedValue({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
    expect((await route(request({}))).status).toBe(403)
    expect(submit).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();expect(sign).not.toHaveBeenCalled()
  })
  it('issues a tenant-scoped immutable storage upload',async()=>{
    const response=await routes.upload(request({filename:'large.se',size:50*1024*1024}))
    expect(response.status).toBe(201)
    expect(sign).toHaveBeenCalledWith(expect.stringMatching(/^company-1\/sie-intake\/[a-f0-9-]+\.se$/),{upsert:false})
    expect((await response.json()).data.token).toBe('upload-token')
  })
  it('refuses an oversized upload before issuing a token',async()=>{
    expect((await routes.upload(request({filename:'large.se',size:50*1024*1024+1}))).status).toBe(400)
    expect(sign).not.toHaveBeenCalled()
  })
  it('accepts a file without running the worker inline',async()=>{
    const form=new FormData()
    form.set('file',new File(['#SIETYP 4\n#RAR 0 20260101 20261231'],'small.se'))
    form.set('mappings','[]')
    const response=await routes.execute(new Request('https://example.test/api/import/sie/execute',{method:'POST',body:form}))
    expect(response.status).toBe(202)
    expect((await response.json()).data.importId).toBe(job.id)
    expect(submit).toHaveBeenCalledWith(supabase,'company-1','actor-1',expect.any(String),[],expect.objectContaining({filename:'small.se'}),expect.any(File))
    const {runSIEWorker}=await import('@/lib/import/sie-job-worker')
    expect(runSIEWorker).not.toHaveBeenCalled()
  })
  it('refuses malformed action input before ownership RPCs',async()=>{
    expect((await act(request({action:'delete'}),params)).status).toBe(400)
    expect(action).not.toHaveBeenCalled()
  })
  it('returns not found for a foreign or missing execution',async()=>{
    action.mockRejectedValue(Object.assign(new Error('Missing execution'),{code:'NOT_FOUND'}))
    expect((await act(request({action:'resume'}),params)).status).toBe(404)
  })
  it('passes authenticated identity to resume and undo',async()=>{
    for(const value of ['resume','undo']) {
      expect((await act(request({action:value}),params)).status).toBe(202)
      expect(action).toHaveBeenLastCalledWith(supabase,'company-1','actor-1',job.id,value)
    }
  })
  it('returns active holds without caching them',async()=>{
    queued.enqueue({data:[{id:'period',name:'2026',import_hold:job.id}]})
    const response=await routes.holds(new Request('https://example.test/api/import/sie/holds'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await response.json()).data[0].import_hold).toBe(job.id)
  })
})
