import {beforeEach,describe,expect,it,vi} from 'vitest'
import {createQueuedMockSupabase} from '@/tests/helpers'
import type {ExtensionContext} from '@/lib/extensions/types'
const mocks=vi.hoisted(()=>({run:vi.fn()}))
vi.mock('../import-documents',()=>({importProviderDocuments:mocks.run,FortnoxDocumentScopesRequiredError:class extends Error{}}))
import {documentReviewRoutes} from '../document-review-routes'
const consentId='11111111-1111-4111-8111-111111111111'
const handler=documentReviewRoutes[0].handler
function context(data:unknown={id:consentId},error:unknown=null){
  const db=createQueuedMockSupabase();db.enqueue({data,error})
  const ctx={companyId:'own-company',userId:'actor',supabase:db.supabase,log:{warn:vi.fn(),error:vi.fn(),info:vi.fn()}} as unknown as ExtensionContext
  return {ctx,...db}
}
const request=(query='')=>new Request('http://localhost/api/extensions/ext/arcim-migration/unmatched-documents?consentId='+consentId+query)
beforeEach(()=>{vi.clearAllMocks();mocks.run.mockResolvedValue({unmatchedReview:{provider:'bokio',total:495,items:[]}})})
describe('GET unmatched source documents',()=>{
  it('requires a company session',async()=>{
    expect((await handler(request())).status).toBe(401);expect(mocks.run).not.toHaveBeenCalled()
  })
  it.each(['&offset=-1','&limit=51','&offset=abc','&query='+ 'a'.repeat(201)])('refuses invalid pagination/search %s before provider access',async query=>{
    expect((await handler(request(query),context().ctx)).status).toBe(400);expect(mocks.run).not.toHaveBeenCalled()
  })
  it('does not resolve foreign or missing consents',async()=>{
    const {ctx,supabase,calls}=context(null)
    expect((await handler(request(),ctx)).status).toBe(404)
    expect(supabase.from).toHaveBeenCalledWith('provider_consents')
    expect(calls).toContainEqual({table:'provider_consents',method:'eq',args:['company_id','own-company']})
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it('uses the server company and actor, requests diagnostics only, and prevents response caching',async()=>{
    const {ctx}=context()
    const response=await handler(request('&offset=25&limit=25&query=V33'),ctx)
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({data:{total:495}})
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({companyId:'own-company',userId:'actor',consentId,dryRun:true,review:{offset:25,limit:25,query:'V33'}}))
  })
  it('fails closed on a consent lookup failure',async()=>{
    expect((await handler(request(),context(null,{message:'offline'}).ctx)).status).toBeGreaterThanOrEqual(400)
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
