import { after, NextResponse } from 'next/server'
import { requestSIEJobAction } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { withRouteContext } from '@/lib/api/with-route-context'

export const maxDuration = 300
/** Compatibility endpoint: queue batch storno; never delete by fiscal period. */
export const DELETE = withRouteContext<{params:Promise<{id:string}>}>(
  'sie_import.undo',async (_request,{supabase,companyId,user},{params}) => {
    const {id} = await params
    const job = await requestSIEJobAction(supabase,companyId!,user.id,id,'undo')
    after(async () => { await runSIEWorker({importId:job.id}) })
    return NextResponse.json({data:job,importId:job.id,state:job.job_state},{status:202})
  },{requireWrite:true},
)
