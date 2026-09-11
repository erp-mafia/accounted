import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { ok } from '@/lib/api/v1/response'

const input = z.object({filename:z.string().max(255).regex(/\.(se|sie|si)$/i),size:z.number().int().positive().max(50*1024*1024)})
const output = z.object({storagePath:z.string(),uploadUrl:z.string(),filename:z.string()})
registerEndpoint({operation:'imports.sie.upload',method:'POST',path:'/api/v1/companies/:companyId/imports/sie/upload',
  summary:'Reserve a direct SIE upload.',description:'Upload exact bytes to uploadUrl with PUT, then submit storagePath and filename to POST /imports/sie. The upload URL expires after two hours.',
  useWhen:'Importing files larger than the function request limit.',doNotUseFor:'Booking a voucher: this only reserves storage.',
  pitfalls:['Use the returned URL once with PUT and application/octet-stream. Submit the returned storagePath after upload completes.'],
  example:{request:{filename:'export.se',size:10485760},response:{data:{storagePath:'company/sie-intake/upload.se',uploadUrl:'https://storage.example/upload',filename:'export.se'}}},
  scope:'bookkeeping:write',risk:'low',idempotent:false,reversible:true,dryRunSupported:false,
  request:{contentType:'application/json',body:input},response:{success:dataEnvelope(output)},
})
export const POST = withApiV1<{params:Promise<{companyId:string}>}>('imports.sie.upload',async (request,ctx) => {
  const body = input.parse(await request.json())
  const path = `${ctx.companyId}/sie-intake/${randomUUID()}.se`
  const {data,error} = await ctx.supabase.storage.from('sie-files').createSignedUploadUrl(path,{upsert:false})
  if (error) throw error
  return ok({storagePath:path,uploadUrl:data.signedUrl,filename:body.filename},{requestId:ctx.requestId})
})
