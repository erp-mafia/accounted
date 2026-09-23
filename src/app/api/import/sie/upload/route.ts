import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { SIE_LIMITS } from '@/lib/import/sie-job-contract'

const schema = z.object({filename:z.string().max(255).regex(/\.(se|sie|si)$/i),size:z.number().int().positive().max(SIE_LIMITS.fileBytes)})
export const POST = withRouteContext('sie_import.upload',async (request,{supabase,companyId}) => {
  schema.parse(await request.json())
  const path = `${companyId}/sie-intake/${randomUUID()}.se`
  const {data,error} = await supabase.storage.from('sie-files').createSignedUploadUrl(path,{upsert:false})
  if (error) throw error
  return NextResponse.json({data:{path,token:data.token}},{status:201})
},{requireWrite:true})
