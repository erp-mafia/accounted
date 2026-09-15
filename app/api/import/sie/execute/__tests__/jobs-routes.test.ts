import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
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
import {POST as createAccounts} from '../../create-accounts/route'
import {POST as upload} from '../../upload/route'
import {POST as act} from '../../[id]/action/route'
import {DELETE as undo} from '../../[id]/undo/route'
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
afterEach(() => vi.unstubAllEnvs())

describe('durable SIE HTTP boundaries',()=>{
  it.each(['undo', 'resume', 'compatibility-undo'])('returns actionable legacy guidance through the real %s service', async name => {
    const actual = await vi.importActual<typeof import('@/lib/import/sie-jobs')>('@/lib/import/sie-jobs')
    action.mockImplementationOnce(actual.requestSIEJobAction)
    queued.enqueue({ data: { id: job.id, job_state: null } })
    const response = name === 'compatibility-undo' ? await undo(request({}), params) : await act(request({ action: name }), params)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatchObject({ code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED',
      message_en: expect.stringContaining('Review'), remediation: { tool: 'gnubok_sie_import_status' } })
    expect(supabase.rpc).not.toHaveBeenCalled()
    const { after } = await import('next/server')
    expect(after).not.toHaveBeenCalled()
  })
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
  it('accepts a custom account created during preview without requiring it to be remapped', async () => {
    queued.enqueue({ data: [{ account_number: '9999' }] })
    const created = await createAccounts(request({ accounts: [{ number: '9999', name: 'Custom account' }] }), staticParams)
    expect(created.status).toBe(200)
    expect((await created.json()).created).toBe(1)

    // A chart-only custom account must not block otherwise ordinary vouchers.
    const mappings = ['9999', '1930', '3001'].map(number => ({
      sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
      confidence: 1, matchType: 'manual', isOverride: false,
    }))
    const form = new FormData()
    form.set('file', new File([
      '#SIETYP 4\n#RAR 0 20260101 20261231\n#KONTO 9999 "Custom account"\n' +
      '#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n' +
      '#VER A 1 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}',
    ], 'custom-account.se'))
    form.set('mappings', JSON.stringify(mappings))
    const response = await routes.execute(new Request('https://example.test/api/import/sie/execute', { method: 'POST', body: form }))

    expect(response.status).toBe(202)
    expect((await response.json()).data.importId).toBe(job.id)
    expect(submit).toHaveBeenCalledWith(supabase, 'company-1', 'actor-1', expect.any(String), mappings,
      expect.objectContaining({ filename: 'custom-account.se' }), expect.any(File))
  })

  it.each(['999', '99999', '99A9', 9999])('rejects malformed target account %j before submitting a job', async targetAccount => {
    const form = new FormData()
    form.set('file', new File(['#SIETYP 4\n#RAR 0 20260101 20261231'], 'invalid-account.se'))
    form.set('mappings', JSON.stringify([{
      sourceAccount: '9999', targetAccount, sourceName: 'Account', targetName: 'Account',
      confidence: 1, matchType: 'manual', isOverride: false,
    }]))
    const response = await routes.execute(new Request('https://example.test/api/import/sie/execute', { method: 'POST', body: form }))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({
      code: 'VALIDATION_ERROR', details: { issues: [expect.objectContaining({ field: '0.targetAccount' })] },
    })
    expect(submit).not.toHaveBeenCalled()
  })
  it('returns actionable bilingual 400 for financial use of class 9 through the real submission validator', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const actual = await vi.importActual<typeof import('@/lib/import/sie-jobs')>('@/lib/import/sie-jobs')
    submit.mockImplementationOnce(actual.submitSIEJob)
    const form = new FormData()
    form.set('file', new File(['#SIETYP 4\n#RAR 0 20260101 20261231\n' +
      '#VER A 1 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 9999 {} -100\n}'], 'custom.se'))
    form.set('mappings', JSON.stringify(['1930', '9999'].map(number => ({
      sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
      confidence: 1, matchType: 'manual', isOverride: true,
    }))))
    const response = await routes.execute(new Request('https://example.test/api/import/sie/execute', { method: 'POST', body: form }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({
      code: 'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
      message: expect.stringContaining('1000-8999'), message_en: expect.stringContaining('1000-8999'),
    })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.storage.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('names both invalid source mappings in the API response instead of a generic 400', async () => {
    const form = new FormData()
    form.set('file', new File(['#SIETYP 4\n#RAR 0 20260101 20261231'], 'invalid-mappings.se'))
    form.set('mappings', JSON.stringify(['999', '193000'].map(number => ({
      sourceAccount: number, targetAccount: number, sourceName: 'Source', targetName: 'Target',
      confidence: 1, matchType: 'manual', isOverride: true,
    }))))
    const response = await routes.execute(new Request('https://example.test/api/import/sie/execute', { method: 'POST', body: form }))
    const { error } = await response.json()
    expect(response.status).toBe(400)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toContain('Källkonto 999')
    expect(error.message).toContain('Källkonto 193000')
    expect(error.message).toContain('måste ha exakt fyra siffror')
    expect(error.message_en).toContain('Source account 193000')
    expect(error.message_en).toContain('four digits')
    expect(submit).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
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
  it('returns manual-review flags after the import hold is released',async()=>{
    queued.enqueue({data:[{id:'period',name:'2027',import_hold:null,opening_balance_review_token:'review'}]})
    const response=await routes.holds(new Request('https://example.test/api/import/sie/holds'))
    expect((await response.json()).data[0]).toMatchObject({import_hold:null,opening_balance_review_token:'review'})
  })
})
