import {beforeEach,describe,expect,it,vi} from 'vitest'
import {NextResponse} from 'next/server'
import {createMockRequest,createMockRouteParams,createQueuedMockSupabase} from '@/tests/helpers'
const {supabase,reset} = createQueuedMockSupabase()
const mocks = vi.hoisted(()=>({auth:vi.fn(),write:vi.fn(),action:vi.fn(),after:vi.fn()}))
vi.mock('next/server',async original=>({...await original<typeof import('next/server')>(),after:mocks.after}))
vi.mock('@/lib/auth/require-auth',()=>({requireAuth:mocks.auth}))
vi.mock('@/lib/auth/require-write',()=>({requireWritePermission:mocks.write}))
vi.mock('@/lib/company/context',()=>({getActiveCompanyId:vi.fn().mockResolvedValue('company-1')}))
vi.mock('@/lib/import/sie-jobs',()=>({requestSIEJobAction:mocks.action}))
vi.mock('@/lib/import/sie-job-worker',()=>({runSIEWorker:vi.fn()}))
import {DELETE} from '../route'
const call=()=>DELETE(createMockRequest('/api/import/sie/import-1/undo',{method:'DELETE'}),createMockRouteParams({id:'import-1'}))
describe('SIE undo compatibility endpoint',()=>{
 beforeEach(()=>{vi.clearAllMocks();reset();mocks.auth.mockResolvedValue({user:{id:'user-1'},supabase});mocks.write.mockResolvedValue({ok:true})})
 it('requires authentication',async()=>{mocks.auth.mockResolvedValue({error:NextResponse.json({}, {status:401})});expect((await call()).status).toBe(401);expect(mocks.action).not.toHaveBeenCalled()})
 it('refuses viewers',async()=>{mocks.write.mockResolvedValue({ok:false,response:NextResponse.json({}, {status:403})});expect((await call()).status).toBe(403)})
 it('returns 404 for a missing batch',async()=>{mocks.action.mockRejectedValue(Object.assign(new Error('not found'),{code:'NOT_FOUND'}));expect((await call()).status).toBe(404)})
 it('queues exact batch storno without claiming it is already undone',async()=>{
  mocks.action.mockResolvedValue({id:'import-1',job_state:'undoing'})
  const response=await call();expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({importId:'import-1',state:'undoing'})
  expect(mocks.action).toHaveBeenCalledWith(supabase,'company-1','user-1','import-1','undo')
  expect(mocks.after).toHaveBeenCalledOnce()
 })
})
