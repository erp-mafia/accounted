import { after, NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SIEJobActionSchema } from '@/lib/api/schemas'
import { requestSIEJobAction } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'

export const maxDuration = 300

export const POST = withRouteContext<{params:Promise<{id:string}>}>('sie_import.action',async (request,ctx,{params}) => {
  const validation = await validateBody(request,SIEJobActionSchema)
  if (!validation.success) return validation.response
  const {id} = await params
  const job = await requestSIEJobAction(ctx.supabase,ctx.companyId!,ctx.user.id,id,validation.data.action)
  after(async () => { await runSIEWorker({importId:job.id}) })
  return NextResponse.json({data:job},{status:202,headers:{'Retry-After':'2'}})
},{requireWrite:true})
